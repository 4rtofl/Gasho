// The program in a pseudo-terminal, started as node-pty starts it (the Node.js host, ../../src/terminal-host.ts): the
// same terminal settings, TERM and PWD added to its environment, and a program that cannot be run ends with code 1.
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ptr;

pub struct Spawned {
    pub master: OwnedFd,
    pub pid: libc::pid_t,
}

pub struct Program<'a> {
    pub file: &'a str,
    pub args: &'a [String],
    pub cwd: &'a str,
    pub env: &'a [(String, String)],
    pub cols: u16,
    pub rows: u16,
}

fn cstring(s: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("a NUL byte in {s:?}")))
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// node-pty's terminal settings (pty.cc), UTF-8 input included.
fn settings() -> libc::termios {
    // SAFETY: termios is plain data; every field that matters is set below.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    t.c_iflag = (libc::ICRNL | libc::IXON | libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8) as _;
    t.c_oflag = (libc::OPOST | libc::ONLCR) as _;
    t.c_cflag = (libc::CREAD | libc::CS8 | libc::HUPCL) as _;
    t.c_lflag = (libc::ICANON
        | libc::ISIG
        | libc::IEXTEN
        | libc::ECHO
        | libc::ECHOE
        | libc::ECHOK
        | libc::ECHOKE
        | libc::ECHOCTL) as _;
    let cc = &mut t.c_cc;
    cc[libc::VEOF] = 4;
    cc[libc::VEOL] = 0xff;
    cc[libc::VEOL2] = 0xff;
    cc[libc::VERASE] = 0x7f;
    cc[libc::VWERASE] = 23;
    cc[libc::VKILL] = 21;
    cc[libc::VREPRINT] = 18;
    cc[libc::VINTR] = 3;
    cc[libc::VQUIT] = 0x1c;
    cc[libc::VSUSP] = 26;
    cc[libc::VSTART] = 17;
    cc[libc::VSTOP] = 19;
    cc[libc::VLNEXT] = 22;
    cc[libc::VDISCARD] = 15;
    cc[libc::VMIN] = 1;
    cc[libc::VTIME] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[libc::VDSUSP] = 25;
        cc[libc::VSTATUS] = 20;
    }
    // SAFETY: t is a valid termios.
    unsafe {
        libc::cfsetispeed(&mut t, libc::B38400);
        libc::cfsetospeed(&mut t, libc::B38400);
    }
    t
}

/// Where the program is looked for: as it is when it has a "/", else in the PATH of its own environment (execvp's).
fn candidates(file: &str, env: &[(String, String)]) -> io::Result<Vec<CString>> {
    if file.contains('/') {
        return Ok(vec![cstring(file)?]);
    }
    let path = env
        .iter()
        .rev()
        .find(|(k, _)| k == "PATH")
        .map_or("/usr/bin:/bin", |(_, v)| v.as_str());
    path.split(':')
        .map(|dir| cstring(&format!("{}/{file}", if dir.is_empty() { "." } else { dir })))
        .collect()
}

/// Starts the program in a new pseudo-terminal. Called before any other thread starts: the child between fork and exec
/// may then use what the parent had set up.
pub fn spawn(p: &Program) -> io::Result<Spawned> {
    let mut env: Vec<(String, String)> = p
        .env
        .iter()
        .filter(|(k, _)| k != "PWD" && k != "TERM")
        .cloned()
        .collect();
    env.push(("PWD".into(), p.cwd.into()));
    env.push(("TERM".into(), "xterm-256color".into()));
    let argv: Vec<CString> = std::iter::once(p.file)
        .chain(p.args.iter().map(String::as_str))
        .map(cstring)
        .collect::<io::Result<_>>()?;
    let envp: Vec<CString> = env
        .iter()
        .map(|(k, v)| cstring(&format!("{k}={v}")))
        .collect::<io::Result<_>>()?;
    let paths = candidates(p.file, &env)?;
    let cwd = cstring(p.cwd)?;
    let failed = format!("gasho-terminal-host: cannot run {}\r\n", p.file);
    let mut argv_p: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
    argv_p.push(ptr::null());
    let mut envp_p: Vec<*const libc::c_char> = envp.iter().map(|s| s.as_ptr()).collect();
    envp_p.push(ptr::null());

    let (mut master, mut slave) = (-1, -1);
    let mut t = settings();
    let mut ws = winsize(p.cols, p.rows);
    // SAFETY: the pointers are to live locals.
    if unsafe { libc::openpty(&mut master, &mut slave, ptr::null_mut(), &mut t, &mut ws) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty gave both, and nothing else owns them.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
        // SAFETY: fd is open.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }

    // SAFETY: no other thread runs yet; the child only makes system calls before exec or _exit.
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        unsafe {
            let s = slave.as_raw_fd();
            libc::setsid();
            libc::ioctl(s, libc::TIOCSCTTY as _, 0);
            for to in 0..3 {
                libc::dup2(s, to);
            }
            // The signals this process ignores or blocks (SIGPIPE, SIGTERM, SIGHUP) are the program's to handle.
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::sigprocmask(libc::SIG_SETMASK, &none, ptr::null_mut());
            for sig in 1..32 {
                libc::signal(sig, libc::SIG_DFL);
            }
            if libc::chdir(cwd.as_ptr()) == 0 {
                for path in &paths {
                    libc::execve(path.as_ptr(), argv_p.as_ptr(), envp_p.as_ptr());
                }
            }
            libc::write(2, failed.as_ptr().cast(), failed.len());
            libc::_exit(1);
        }
    }
    drop(slave);
    Ok(Spawned { master, pid })
}

pub fn resize(master: RawFd, cols: u16, rows: u16) {
    let ws = winsize(cols, rows);
    // SAFETY: ws is a valid winsize; a closed terminal only makes the call fail.
    unsafe { libc::ioctl(master, libc::TIOCSWINSZ as _, &ws) };
}
