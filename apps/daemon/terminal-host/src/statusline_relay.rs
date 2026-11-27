// The status line command of the sessions gasho-daemon starts, in Rust: what ../../src/statusline-relay.ts does, without
// starting Node.js at every update of the status line (`gasho-terminal-host statusline-relay`, with what Claude Code
// reports as JSON on stdin). It sends the session's id, its context window and the plan's usage limits to gasho-daemon,
// and runs the status line command the user set up (if any) with the same JSON, passing on what that prints and its
// exit code. It never fails the status line: gasho-daemon being away only means that nothing is sent.
use std::env;
use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

/// The variables meant for the relay alone, not for the user's command (OWN in statusline-relay.ts).
const OWN: [&str; 4] = [
    "GASHO_STATUSLINE_URL",
    "GASHO_STATUSLINE_SECRET",
    "GASHO_STATUSLINE_COMMAND",
    "GASHO_STATUSLINE_SEND_MS",
];
/// How long the update may take to reach gasho-daemon; the tests set a longer one in GASHO_STATUSLINE_SEND_MS.
const SEND_MS: f64 = 2000.0;

/// Runs the relay; returns the exit code of the user's command (0 without one).
pub fn run() -> i32 {
    let mut input = Vec::new();
    let _ = io::stdin().read_to_end(&mut input);
    let user = env::var_os("GASHO_STATUSLINE_COMMAND").filter(|c| !c.is_empty());
    thread::scope(|s| {
        s.spawn(|| send(&input));
        user.map_or(0, |c| run_user_command(&c, &input))
    })
}

fn send(input: &[u8]) {
    let Some(url) = env::var("GASHO_STATUSLINE_URL").ok().filter(|u| !u.is_empty()) else {
        return;
    };
    let Ok(Value::Object(mut p)) = serde_json::from_slice::<Value>(input) else {
        return;
    };
    let mut body = serde_json::Map::new();
    for k in ["session_id", "context_window", "rate_limits"] {
        if let Some(v) = p.remove(k) {
            body.insert(k.into(), v);
        }
    }
    let ms = env::var("GASHO_STATUSLINE_SEND_MS")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .unwrap_or(SEND_MS);
    let secret = env::var("GASHO_STATUSLINE_SECRET").ok().filter(|s| !s.is_empty());
    // gasho-daemon is not running, or is restarting.
    let _ = post(
        &url,
        &Value::Object(body).to_string(),
        secret.as_deref(),
        Instant::now() + Duration::from_secs_f64(ms / 1000.0),
    );
}

/// POSTs `body` as JSON to `url` (http://<host>:<port><path>, as statusLineUrl gives it), with the hook server's secret,
/// and waits for the answer: the hook server answers once it has read the whole update.
fn post(url: &str, body: &str, secret: Option<&str>, deadline: Instant) -> io::Result<()> {
    let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidInput, what.to_string());
    let rest = url.strip_prefix("http://").ok_or_else(|| invalid("not an http URL"))?;
    let (authority, path) = rest.find('/').map_or((rest, "/"), |i| rest.split_at(i));
    if authority.is_empty()
        || [authority, path, secret.unwrap_or("")]
            .iter()
            .any(|s| s.chars().any(char::is_control))
    {
        return Err(invalid("not a URL or a secret that can be sent"));
    }
    let has_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, p)| p.parse::<u16>().is_ok());
    let address = if has_port {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    let left = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(io::ErrorKind::TimedOut)
    };
    let mut stream = None;
    for a in address.to_socket_addrs()? {
        if let Ok(s) = TcpStream::connect_timeout(&a, left()?) {
            stream = Some(s);
            break;
        }
    }
    let mut stream = stream.ok_or(io::ErrorKind::ConnectionRefused)?;
    let secret = secret.map_or(String::new(), |s| format!("X-Gasho-Secret: {s}\r\n"));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{secret}Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.set_write_timeout(Some(left()?))?;
    stream.write_all(request.as_bytes())?;
    stream.set_read_timeout(Some(left()?))?;
    match stream.read(&mut [0u8; 256])? {
        0 => Err(io::ErrorKind::UnexpectedEof.into()),
        _ => Ok(()),
    }
}

/// Runs the user's status line command as Claude Code would (bash, else sh), with the JSON on its stdin and the
/// relay's stdout and stderr. Returns its exit code (1 when a signal ended it), or 0 when it could not be started.
fn run_user_command(command: &OsStr, input: &[u8]) -> i32 {
    for shell in ["bash", "/bin/sh"] {
        let mut cmd = Command::new(shell);
        cmd.arg("-c").arg(command).stdin(Stdio::piped());
        for k in OWN {
            cmd.env_remove(k);
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == io::ErrorKind::NotFound && shell == "bash" => continue,
            Err(_) => return 0,
        };
        // A command that reads none of it ends the pipe; that is no failure.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input);
        }
        return child.wait().map_or(0, |s| s.code().unwrap_or(1));
    }
    0
}
