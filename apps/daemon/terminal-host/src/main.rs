// The terminal of one session that gasho-daemon started, in Rust: what ../../src/terminal-host.ts does, with the same
// socket protocol (HOST_PROTOCOL in terminal.ts) and the same settings file, so that gasho-daemon tells the two apart by
// nothing but their memory. The screen is kept by alacritty_terminal instead of xterm.js. Run by gasho-daemon only:
// `gasho-terminal-host <config.json>`.
mod pty;
mod screen;

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{self, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, Timeout};
use serde_json::{Value, json};

const PROTOCOL: u32 = 1;
/// How long the last screen of a program that exited stays readable (the daemon logs the end of a failed launch).
const EXITED_KEEP: Duration = Duration::from_secs(60);
/// How long the program has to end after SIGHUP before it is killed.
const HANGUP_WAIT: Duration = Duration::from_secs(3);
/// Lines before the screen that `attach` shows too.
const ATTACH_SCROLLBACK: usize = 1000;
const SCROLLBACK: usize = 5000;
/// Between two keys (KEY_GAP_MS in terminal.ts).
const KEY_GAP: Duration = Duration::from_millis(25);
/// How long the last output of a program that exited may take to be read, before the viewers are told of the end.
const LAST_OUTPUT_WAIT: Duration = Duration::from_millis(500);

struct Config {
    name: String,
    socket: PathBuf,
    file: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
}

fn read_config(file: &Path) -> Result<Config, String> {
    let text = fs::read_to_string(file).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", file.display()))?;
    let text_of = |k: &str| {
        v[k].as_str()
            .map(String::from)
            .ok_or_else(|| format!("{} has no {k}", file.display()))
    };
    let size_of = |k: &str| {
        v[k].as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .ok_or_else(|| format!("{} has no {k}", file.display()))
    };
    Ok(Config {
        name: text_of("name")?,
        socket: text_of("socket")?.into(),
        file: text_of("file")?,
        args: v["args"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        cwd: text_of("cwd")?,
        env: v["env"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, x)| x.as_str().map(|x| (k.clone(), x.to_string())))
                    .collect()
            })
            .unwrap_or_default(),
        cols: size_of("cols")?,
        rows: size_of("rows")?,
    })
}

/// Now, as JavaScript's toISOString writes it.
fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days to a date in the proleptic Gregorian calendar (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let (era, doe) = (z.div_euclid(146_097), z.rem_euclid(146_097));
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

fn line(v: &Value) -> Arc<str> {
    format!("{v}\n").into()
}

/// The terminal's answers to the program's questions (device attributes, cursor position, …) go to the program.
struct Answers(Sender<Vec<u8>>);

impl EventListener for Answers {
    fn send_event(&self, event: Event) {
        let Event::PtyWrite(text) = event else { return };
        // Where Alacritty's answers differ from xterm.js's (the Node.js host's), xterm.js's: a program that tells
        // terminals apart by them sees the same one on both hosts.
        let text = match text.as_str() {
            "\x1b[?6c" => "\x1b[?1;2c".to_string(),
            t if t.starts_with("\x1b[>0;") && t.ends_with('c') => "\x1b[>0;276;0c".to_string(),
            // The size of the text area, which xterm.js does not tell.
            t if t.starts_with("\x1b[8;") && t.ends_with('t') => return,
            _ => text,
        };
        _ = self.0.send(text.into_bytes());
    }
}

/// A synchronized update (DECSET 2026) is shown at once, as xterm.js shows it: nothing waits for its end to be read.
#[derive(Default)]
struct Unsynced;

impl Timeout for Unsynced {
    fn set_timeout(&mut self, _: Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

#[derive(Clone, Copy)]
struct Exit {
    code: i32,
    signal: i32,
}

impl Exit {
    fn json(self) -> Value {
        if self.signal != 0 {
            json!({ "code": self.code, "signal": self.signal })
        } else {
            json!({ "code": self.code })
        }
    }
}

enum ToViewer {
    Line(Arc<str>),
    /// The last line, then the connection closes.
    End(Arc<str>),
}

struct Viewer {
    id: u64,
    size: (u16, u16),
    tx: Sender<ToViewer>,
}

struct State {
    term: Term<Answers>,
    parser: Processor<Unsynced>,
    exited: Option<Exit>,
    /// The program's side of the terminal is closed, and everything it wrote has been read.
    drained: bool,
    viewers: Vec<Viewer>,
    next_viewer: u64,
    closing: bool,
}

struct Host {
    cfg: Config,
    config_file: PathBuf,
    started_at: u64,
    pid: libc::pid_t,
    master: OwnedFd,
    /// What is typed into the program, in order; nothing is once it has exited.
    to_program: Sender<Vec<u8>>,
    exited: AtomicBool,
    state: Mutex<State>,
    changed: Condvar,
}

impl Host {
    fn log(&self, what: &str) {
        println!("{} [terminal {}] {what}", iso_now(), self.cfg.name);
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn hello(&self, st: &State) -> Value {
        let mut v = json!({
            "ok": true,
            "version": PROTOCOL,
            "name": self.cfg.name,
            "pid": self.pid,
            "hostPid": std::process::id(),
            "cwd": self.cfg.cwd,
            "startedAt": self.started_at,
            "viewers": st.viewers.len(),
        });
        if let Some(e) = st.exited {
            v["exited"] = e.json();
        }
        v
    }

    /// The size of the newest viewer, or the terminal's own when nobody is attached.
    fn resize_to_viewers(&self, st: &mut State) {
        let (cols, rows) = st.viewers.last().map_or((self.cfg.cols, self.cfg.rows), |v| v.size);
        let grid = st.term.grid();
        if usize::from(cols) == grid.columns() && usize::from(rows) == grid.screen_lines() {
            return;
        }
        st.term.resize(Size {
            cols: cols.into(),
            rows: rows.into(),
        });
        if st.exited.is_none() {
            pty::resize(self.master.as_raw_fd(), cols, rows);
        }
    }

    fn type_in(&self, bytes: impl Into<Vec<u8>>) {
        _ = self.to_program.send(bytes.into());
    }
}

/// A size from a viewer: a whole number from 10 to 1000, or `fallback`.
fn size(v: &Value, fallback: u16) -> u16 {
    match v.as_f64() {
        Some(n) if n.fract() == 0.0 && (10.0..=1000.0).contains(&n) => n as u16,
        _ => fallback,
    }
}

/// What JavaScript's String() makes of a value read from a request.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// Writes the lines for one viewer, so that a slow one holds up nothing else.
fn viewer_writer(mut c: UnixStream, rx: Receiver<ToViewer>) {
    for m in rx {
        match m {
            ToViewer::Line(l) => {
                if c.write_all(l.as_bytes()).is_err() {
                    return;
                }
            }
            ToViewer::End(l) => {
                _ = c.write_all(l.as_bytes());
                _ = c.shutdown(std::net::Shutdown::Write);
                return;
            }
        }
    }
}

fn attach(host: &Host, c: &UnixStream, m: &Value) -> Option<(u64, Sender<ToViewer>)> {
    let (tx, rx) = mpsc::channel();
    let w = c.try_clone().ok()?;
    thread::spawn(move || viewer_writer(w, rx));
    let mut st = host.lock();
    let id = st.next_viewer;
    st.next_viewer += 1;
    let size = (size(&m["cols"], host.cfg.cols), size(&m["rows"], host.cfg.rows));
    st.viewers.push(Viewer {
        id,
        size,
        tx: tx.clone(),
    });
    host.resize_to_viewers(&mut st);
    _ = tx.send(ToViewer::Line(line(&json!({ "ok": true }))));
    // What is on the screen now, with the lines above it and the modes the program set; the program redraws its part
    // on the resize too.
    let screen = format!("\x1b[H\x1b[2J{}", screen::serialize(&st.term, ATTACH_SCROLLBACK));
    _ = tx.send(ToViewer::Line(line(&json!({ "out": screen }))));
    if let Some(e) = st.exited {
        _ = tx.send(ToViewer::End(line(&json!({ "exit": e.json() }))));
    }
    Some((id, tx))
}

fn viewer_input(host: &Host, id: u64, m: &Value) {
    if let Some(text) = m["in"].as_str() {
        host.type_in(text);
    }
    if let Some(r) = m["resize"].as_array() {
        let mut st = host.lock();
        let size = (
            size(r.first().unwrap_or(&Value::Null), host.cfg.cols),
            size(r.get(1).unwrap_or(&Value::Null), host.cfg.rows),
        );
        if let Some(v) = st.viewers.iter_mut().find(|v| v.id == id) {
            v.size = size;
        }
        host.resize_to_viewers(&mut st);
    }
}

/// Answers one request; None when the answer has been sent already.
fn handle(host: &Arc<Host>, c: &mut UnixStream, m: &Value) -> Result<Option<Value>, String> {
    let exited = || {
        if host.exited.load(Ordering::SeqCst) {
            Err("the program has exited".to_string())
        } else {
            Ok(())
        }
    };
    match m.get("op").and_then(Value::as_str) {
        Some("hello") => Ok(Some(host.hello(&host.lock()))),
        Some("screen") => Ok(Some(
            json!({ "ok": true, "ansi": screen::dump_screen(&host.lock().term) }),
        )),
        Some("keys") => {
            exited()?;
            let keys: Vec<String> = m["keys"]
                .as_array()
                .map(|a| a.iter().map(|k| js_string(Some(k))).collect())
                .unwrap_or_default();
            // Every name is checked before the first key is pressed: no half of a request is typed.
            for k in &keys {
                screen::key_bytes(k, false)?;
            }
            for k in &keys {
                let app_cursor = host.lock().term.mode().contains(TermMode::APP_CURSOR);
                host.type_in(screen::key_bytes(k, app_cursor)?);
                thread::sleep(KEY_GAP);
            }
            Ok(Some(json!({ "ok": true })))
        }
        Some("paste") => {
            exited()?;
            let text = match m.get("text") {
                None | Some(Value::Null) => String::new(),
                v => js_string(v),
            };
            let bracketed = host.lock().term.mode().contains(TermMode::BRACKETED_PASTE);
            host.type_in(screen::paste_bytes(&text, bracketed));
            Ok(Some(json!({ "ok": true })))
        }
        Some("kill") => {
            _ = c.write_all(line(&json!({ "ok": true })).as_bytes());
            _ = c.shutdown(std::net::Shutdown::Write);
            shutdown(host, "asked to");
            Ok(None)
        }
        _ => Err(format!("unknown request: {}", js_string(m.get("op")))),
    }
}

fn serve(host: Arc<Host>, mut c: UnixStream) {
    let Ok(read) = c.try_clone() else { return };
    let mut viewer: Option<(u64, Sender<ToViewer>)> = None;
    // One request at a time per connection, in order.
    for text in BufReader::new(read).split(b'\n') {
        let Ok(text) = text else { break };
        let text = String::from_utf8_lossy(&text);
        if text.trim().is_empty() {
            continue;
        }
        let Ok(m) = serde_json::from_str::<Value>(&text) else {
            let refused = line(&json!({ "ok": false, "error": "not JSON" }));
            match &viewer {
                Some((_, tx)) => _ = tx.send(ToViewer::Line(refused)),
                None => _ = c.write_all(refused.as_bytes()),
            }
            continue;
        };
        if let Some((id, _)) = &viewer {
            viewer_input(&host, *id, &m);
            continue;
        }
        if m["op"] == "attach" {
            viewer = attach(&host, &c, &m);
            continue;
        }
        match handle(&host, &mut c, &m) {
            Ok(Some(res)) => _ = c.write_all(line(&res).as_bytes()),
            Ok(None) => {}
            Err(e) => _ = c.write_all(line(&json!({ "ok": false, "error": e })).as_bytes()),
        }
    }
    if let Some((id, _)) = viewer {
        let mut st = host.lock();
        st.viewers.retain(|v| v.id != id);
        host.resize_to_viewers(&mut st);
    }
}

/// UTF-8 for the viewers, from bytes that may end inside a character (kept in `carry` for the next read).
fn decode(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut out = String::new();
    let mut rest = &carry[..];
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                rest = &[];
                break;
            }
            Err(e) => {
                let (good, bad) = rest.split_at(e.valid_up_to());
                out.push_str(std::str::from_utf8(good).unwrap_or_default());
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{fffd}');
                        rest = &bad[n..];
                    }
                    None => {
                        rest = bad;
                        break;
                    }
                }
            }
        }
    }
    *carry = rest.to_vec();
    out
}

fn read_program(host: Arc<Host>) {
    let Ok(fd) = host.master.try_clone() else { return };
    let mut from = fs::File::from(fd);
    let mut buf = vec![0u8; 64 * 1024];
    let mut carry = Vec::new();
    loop {
        match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = decode(&mut carry, &buf[..n]);
                let mut st = host.lock();
                let st = &mut *st;
                st.parser.advance(&mut st.term, &buf[..n]);
                if !text.is_empty() {
                    let out = line(&json!({ "out": text }));
                    for v in &st.viewers {
                        _ = v.tx.send(ToViewer::Line(out.clone()));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // EIO: the program's side is closed (Linux).
            Err(_) => break,
        }
    }
    host.lock().drained = true;
    host.changed.notify_all();
}

fn write_program(host: Arc<Host>, rx: Receiver<Vec<u8>>) {
    let Ok(fd) = host.master.try_clone() else { return };
    let mut to = fs::File::from(fd);
    for bytes in rx {
        if host.exited.load(Ordering::SeqCst) {
            continue;
        }
        _ = to.write_all(&bytes);
    }
}

fn wait_program(host: Arc<Host>) {
    let mut status = 0;
    loop {
        // SAFETY: status is a valid place for the status.
        let r = unsafe { libc::waitpid(host.pid, &mut status, 0) };
        if r == host.pid {
            break;
        }
        if r < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            break;
        }
    }
    let exit = if libc::WIFSIGNALED(status) {
        Exit {
            code: 0,
            signal: libc::WTERMSIG(status),
        }
    } else {
        Exit {
            code: libc::WEXITSTATUS(status),
            signal: 0,
        }
    };
    host.exited.store(true, Ordering::SeqCst);
    host.lock().exited = Some(exit);
    host.changed.notify_all();
    host.log(&if exit.signal != 0 {
        format!("the program exited (signal {})", exit.signal)
    } else {
        format!("the program exited (code {})", exit.code)
    });
    {
        // Its last output reaches the viewers first.
        let st = host.lock();
        let (st, _) = host
            .changed
            .wait_timeout_while(st, LAST_OUTPUT_WAIT, |st| !st.drained)
            .unwrap_or_else(|e| e.into_inner());
        let end = line(&json!({ "exit": exit.json() }));
        for v in &st.viewers {
            _ = v.tx.send(ToViewer::End(end.clone()));
        }
    }
    thread::sleep(EXITED_KEEP);
    shutdown(&host, "the program exited a while ago");
}

/// Ends the program (SIGHUP, then SIGKILL) and the host, and removes the socket, the settings and the log.
fn shutdown(host: &Arc<Host>, reason: &str) {
    {
        let mut st = host.lock();
        if st.closing {
            return;
        }
        st.closing = true;
        host.log(&format!("closing: {reason}"));
        let end = line(&json!({ "exit": st.exited.map_or(json!({ "code": -1 }), Exit::json) }));
        for v in &st.viewers {
            _ = v.tx.send(ToViewer::End(end.clone()));
        }
    }
    // The log is kept only when the host dies without closing (its end tells why).
    let log = host.config_file.with_file_name(format!("{}.log", host.cfg.name));
    for f in [host.cfg.socket.as_path(), host.config_file.as_path(), log.as_path()] {
        _ = fs::remove_file(f);
    }
    // A moment for the last answers to leave.
    let end = || {
        thread::sleep(Duration::from_millis(100));
        std::process::exit(0);
    };
    if host.exited.load(Ordering::SeqCst) {
        end();
    }
    // SAFETY: a signal to the program's PID.
    unsafe { libc::kill(host.pid, libc::SIGHUP) };
    let st = host.lock();
    let (st, waited) = host
        .changed
        .wait_timeout_while(st, HANGUP_WAIT, |st| st.exited.is_none())
        .unwrap_or_else(|e| e.into_inner());
    drop(st);
    if !waited.timed_out() {
        end();
    }
    // SAFETY: as above.
    unsafe { libc::kill(host.pid, libc::SIGKILL) };
    std::process::exit(0);
}

fn listen(host: &Arc<Host>) {
    // A socket left behind by a host that died: the name is new to this terminal, so nobody else answers on it.
    _ = fs::remove_file(&host.cfg.socket);
    let listener = match UnixListener::bind(&host.cfg.socket) {
        Ok(l) => l,
        Err(e) => {
            host.log(&format!("cannot listen: {e}"));
            shutdown(host, "cannot listen");
            return;
        }
    };
    _ = fs::set_permissions(&host.cfg.socket, fs::Permissions::from_mode(0o600));
    host.log(&format!("listening on {}", host.cfg.socket.display()));
    let host = host.clone();
    thread::spawn(move || {
        for c in listener.incoming().flatten() {
            let host = host.clone();
            thread::spawn(move || serve(host, c));
        }
    });
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_default();
    if arg == "--version" {
        println!(
            "gasho-terminal-host {} (protocol {PROTOCOL})",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    if arg.is_empty() {
        eprintln!("usage: gasho-terminal-host <config.json>");
        std::process::exit(2);
    }
    let config_file = PathBuf::from(&arg);
    let cfg = read_config(&config_file).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let spawned = pty::spawn(&pty::Program {
        file: &cfg.file,
        args: &cfg.args,
        cwd: &cfg.cwd,
        env: &cfg.env,
        cols: cfg.cols,
        rows: cfg.rows,
    })
    .unwrap_or_else(|e| {
        eprintln!("cannot start {}: {e}", cfg.file);
        std::process::exit(1);
    });

    // SIGTERM ends the session; SIGHUP does nothing (the host has no terminal of its own: gasho-daemon starts it in a
    // session of its own). Both are taken by sigwait below, so they are blocked in every thread from here.
    // SAFETY: a set made empty first, then given two signals.
    let signals = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGHUP);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };

    let (to_program, typed) = mpsc::channel();
    let term_config = term::Config {
        scrolling_history: SCROLLBACK,
        kitty_keyboard: false,
        osc52: term::Osc52::Disabled,
        ..Default::default()
    };
    let term = Term::new(
        term_config,
        &Size {
            cols: cfg.cols.into(),
            rows: cfg.rows.into(),
        },
        Answers(to_program.clone()),
    );
    let host = Arc::new(Host {
        config_file,
        started_at,
        pid: spawned.pid,
        master: spawned.master,
        to_program,
        exited: AtomicBool::new(false),
        state: Mutex::new(State {
            term,
            parser: Processor::new(),
            exited: None,
            drained: false,
            viewers: Vec::new(),
            next_viewer: 0,
            closing: false,
        }),
        changed: Condvar::new(),
        cfg,
    });
    host.log(&format!(
        "started {} {} (pid {}) in {}",
        host.cfg.file,
        host.cfg.args.join(" "),
        host.pid,
        host.cfg.cwd
    ));
    for run in [read_program as fn(Arc<Host>), wait_program] {
        let host = host.clone();
        thread::spawn(move || run(host));
    }
    {
        let host = host.clone();
        thread::spawn(move || write_program(host, typed));
    }
    listen(&host);

    loop {
        let mut sig = 0;
        // SAFETY: signals is the set blocked above.
        if unsafe { libc::sigwait(&signals, &mut sig) } == 0 && sig == libc::SIGTERM {
            shutdown(&host, "SIGTERM");
        }
    }
}
