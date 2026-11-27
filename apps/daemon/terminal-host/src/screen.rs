// What the host reads from the terminal and types into it, as the Node.js host does (../../src/terminal.ts).
use std::fmt::Write;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

/// The bytes of a key, by the names gasho-daemon uses (keyBytes in terminal.ts).
pub fn key_bytes(key: &str, app_cursor: bool) -> Result<String, String> {
    let named = match key {
        "Enter" => Some("\r"),
        "Esc" => Some("\x1b"),
        "Backspace" => Some("\x7f"),
        "Tab" => Some("\t"),
        "Space" => Some(" "),
        _ => None,
    };
    if let Some(s) = named {
        return Ok(s.into());
    }
    let arrow = match key {
        "Up" => Some('A'),
        "Down" => Some('B'),
        "Right" => Some('C'),
        "Left" => Some('D'),
        _ => None,
    };
    if let Some(a) = arrow {
        return Ok(format!("\x1b{}{a}", if app_cursor { 'O' } else { '[' }));
    }
    let b = key.as_bytes();
    if b.len() == 6 && b[..5].eq_ignore_ascii_case(b"ctrl ") && b[5].is_ascii_alphabetic() {
        return Ok(char::from(b[5].to_ascii_lowercase() - 96).to_string());
    }
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next())
        && !(c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
    {
        return Ok(key.into());
    }
    Err(format!(
        "unknown key: {}",
        serde_json::to_string(key).unwrap_or_default()
    ))
}

/// The bytes that paste `text` (pasteBytes in terminal.ts).
pub fn paste_bytes(text: &str, bracketed: bool) -> String {
    let clean = text.replace('\x1b', "");
    if bracketed {
        format!("\x1b[200~{clean}\x1b[201~")
    } else {
        clean
    }
}

fn push_chars(s: &mut String, cell: &Cell) {
    if cell.flags.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
        s.push(' ');
        return;
    }
    s.push(cell.c);
    if let Some(z) = cell.zerowidth() {
        s.extend(z);
    }
}

/// The screen with only dim and reverse video marked (dumpScreen in terminal.ts).
pub fn dump_screen<T: EventListener>(term: &Term<T>) -> String {
    let grid = term.grid();
    let mut lines = Vec::with_capacity(grid.screen_lines());
    for y in 0..grid.screen_lines() {
        let row = &grid[Line(y as i32)];
        let mut s = String::new();
        let (mut dim, mut inverse) = (false, false);
        for x in 0..grid.columns() {
            let cell = &row[Column(x)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let d = cell.flags.contains(Flags::DIM);
            let i = cell.flags.contains(Flags::INVERSE);
            if d != dim {
                s.push_str(if d { "\x1b[2m" } else { "\x1b[22m" });
            }
            if i != inverse {
                s.push_str(if i { "\x1b[7m" } else { "\x1b[27m" });
            }
            dim = d;
            inverse = i;
            push_chars(&mut s, cell);
        }
        if dim || inverse {
            s.push_str("\x1b[0m");
        }
        lines.push(s);
    }
    lines.join("\n")
}

const STYLE: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

#[derive(PartialEq, Clone, Copy)]
struct Pen {
    fg: Color,
    bg: Color,
    flags: Flags,
}

const PLAIN: Pen = Pen {
    fg: Color::Named(NamedColor::Foreground),
    bg: Color::Named(NamedColor::Background),
    flags: Flags::empty(),
};

fn pen_of(cell: &Cell) -> Pen {
    Pen {
        fg: cell.fg,
        bg: cell.bg,
        flags: cell.flags & STYLE,
    }
}

fn push_color(s: &mut String, c: Color, base: u8, bright: u8, ext: u8) {
    let named = |n: NamedColor| -> Option<u8> {
        let i = n as usize;
        match i {
            0..=15 => Some(i as u8),
            _ if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&i) => {
                Some((i - NamedColor::DimBlack as usize) as u8)
            }
            _ => None,
        }
    };
    match c {
        Color::Named(n) => match named(n) {
            Some(i) if i < 8 => _ = write!(s, ";{}", base + i),
            Some(i) => _ = write!(s, ";{}", bright + i - 8),
            None => {}
        },
        Color::Indexed(i) => _ = write!(s, ";{ext};5;{i}"),
        Color::Spec(rgb) => _ = write!(s, ";{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b),
    }
}

fn push_pen(s: &mut String, p: Pen) {
    s.push_str("\x1b[0");
    for (flag, code) in [
        (Flags::BOLD, "1"),
        (Flags::DIM, "2"),
        (Flags::ITALIC, "3"),
        (Flags::UNDERLINE, "4"),
        (Flags::DOUBLE_UNDERLINE, "4:2"),
        (Flags::UNDERCURL, "4:3"),
        (Flags::DOTTED_UNDERLINE, "4:4"),
        (Flags::DASHED_UNDERLINE, "4:5"),
        (Flags::INVERSE, "7"),
        (Flags::HIDDEN, "8"),
        (Flags::STRIKEOUT, "9"),
    ] {
        if p.flags.contains(flag) {
            s.push(';');
            s.push_str(code);
        }
    }
    push_color(s, p.fg, 30, 90, 38);
    push_color(s, p.bg, 40, 100, 48);
    s.push('m');
}

fn blank(cell: &Cell) -> bool {
    cell.c == ' ' && cell.zerowidth().is_none() && pen_of(cell) == PLAIN
}

/// What draws the terminal again in another one of the same size (`attach`): up to `scrollback` lines above the
/// screen, the screen with its colors and styles, the cursor and the modes that change what keys and the mouse send.
/// It is what xterm.js's SerializeAddon gave the Node.js host.
pub fn serialize<T: EventListener>(term: &Term<T>, scrollback: usize) -> String {
    let grid = term.grid();
    let mode = *term.mode();
    let mut s = String::new();
    // The other screen's lines are not kept: what a program draws there, it draws again.
    let alt = mode.contains(TermMode::ALT_SCREEN);
    if alt {
        s.push_str("\x1b[?1049h\x1b[H\x1b[2J");
    }
    let above = if alt { 0 } else { grid.history_size().min(scrollback) };
    let cols = grid.columns();
    let last = grid.screen_lines() as i32 - 1;
    let mut pen = PLAIN;
    for y in -(above as i32)..=last {
        let row = &grid[Line(y)];
        let wraps = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        let end = if wraps {
            cols
        } else {
            (0..cols).rev().find(|&x| !blank(&row[Column(x)])).map_or(0, |x| x + 1)
        };
        for x in 0..end {
            let cell = &row[Column(x)];
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }
            let p = pen_of(cell);
            if p != pen {
                push_pen(&mut s, p);
                pen = p;
            }
            push_chars(&mut s, cell);
        }
        if y != last && !wraps {
            // A line break with a background color would paint the new line with it.
            if pen != PLAIN {
                s.push_str("\x1b[0m");
                pen = PLAIN;
            }
            s.push_str("\r\n");
        }
    }
    if pen != PLAIN {
        s.push_str("\x1b[0m");
    }
    for (flag, on) in [
        (TermMode::APP_CURSOR, "\x1b[?1h"),
        (TermMode::APP_KEYPAD, "\x1b="),
        (TermMode::INSERT, "\x1b[4h"),
        (TermMode::ORIGIN, "\x1b[?6h"),
        (TermMode::MOUSE_REPORT_CLICK, "\x1b[?1000h"),
        (TermMode::MOUSE_DRAG, "\x1b[?1002h"),
        (TermMode::MOUSE_MOTION, "\x1b[?1003h"),
        (TermMode::FOCUS_IN_OUT, "\x1b[?1004h"),
        (TermMode::UTF8_MOUSE, "\x1b[?1005h"),
        (TermMode::SGR_MOUSE, "\x1b[?1006h"),
        (TermMode::BRACKETED_PASTE, "\x1b[?2004h"),
    ] {
        if mode.contains(flag) {
            s.push_str(on);
        }
    }
    if !mode.contains(TermMode::LINE_WRAP) {
        s.push_str("\x1b[?7l");
    }
    let at = grid.cursor.point;
    _ = write!(s, "\x1b[{};{}H", at.line.0 + 1, at.column.0 + 1);
    if !mode.contains(TermMode::SHOW_CURSOR) {
        s.push_str("\x1b[?25l");
    }
    s
}
