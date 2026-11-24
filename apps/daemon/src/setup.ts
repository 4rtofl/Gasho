// Setting up gasho-daemon on a working server: `doctor` checks what is in place, and `service print` writes the file
// that keeps the daemon running (a systemd user service on Linux, a launchd agent on macOS) with this machine's paths.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { credentialsPath, loadCredentials } from "./credentials.ts";
import { hookUrl, installedHookEvents } from "./hooks.ts";
import { cellarNode, serviceNode, stableNode } from "./node-path.ts";
import { terminalWorks } from "./terminal.ts";

const execFileP = promisify(execFile);

/** One line of `doctor`: ✓ in place, ! missing but only a feature is lost, ✗ the daemon cannot work. */
export interface Check {
  level: "ok" | "warn" | "fail";
  name: string;
  detail: string;
  /** What to do about it. */
  hint?: string;
}

/** "v24.1.0", "git version 2.43.0", "2.1.323 (Claude Code)" → [24, 1, 0] … */
export function versionOf(text: string): number[] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function atLeast(found: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = found[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

async function run(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 10_000 });
    return `${stdout}${stderr}`.trim();
  } catch (e) {
    const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown };
    // Not installed: undefined. Ran but failed: its output (gh auth status fails when logged out).
    if (err.code === "ENOENT") return undefined;
    return `${typeof err.stdout === "string" ? err.stdout : ""}${typeof err.stderr === "string" ? err.stderr : ""}`.trim() || "error";
  }
}

/** Whether something listens on 127.0.0.1:`port` (the daemon's hook server, so the daemon is running). */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 2000 });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

/**
 * What gasho-daemon needs on this machine, and what each missing thing costs. `command`: how to type gasho-daemon
 * here, for the hints (see install.ts).
 */
export async function doctor(o: {
  claudeBin: string;
  ghBin: string;
  hookPort: number;
  settingsFile: string;
  /** The service's file (serviceFile), for the Node.js it runs. */
  serviceFile?: string;
  command?: string;
}): Promise<Check[]> {
  const DAEMON = o.command ?? "node apps/daemon/src/cli.ts";
  const checks: Check[] = [];
  const node = versionOf(process.versions.node) ?? [0];
  checks.push(
    atLeast(node, [24])
      ? { level: "ok", name: "Node.js", detail: process.versions.node }
      : { level: "fail", name: "Node.js", detail: process.versions.node, hint: "Node.js 24 以上を入れてください" },
  );

  const file = credentialsPath();
  const creds = await loadCredentials(file).catch(() => undefined);
  if (!creds) {
    checks.push({
      level: "fail",
      name: "登録",
      detail: `${file} がありません`,
      hint: `Gasho サーバーで登録コードを出し、${DAEMON} register --server http://<Gasho サーバー>:7740 --code <コード>`,
    });
  } else {
    checks.push({ level: "ok", name: "登録", detail: `「${creds.name || os.hostname()}」として ${creds.server} に登録済み` });
    let status: number | undefined;
    try {
      status = (await fetch(creds.server, { signal: AbortSignal.timeout(5000) })).status;
    } catch {
      status = undefined;
    }
    checks.push(
      status === undefined
        ? { level: "fail", name: "Gasho サーバー", detail: `${creds.server} につながりません`, hint: "Gasho サーバーが動いているか、アドレスが合っているかを確かめてください" }
        : status === 403
          ? { level: "fail", name: "Gasho サーバー", detail: "このマシンからの接続が許可されていません", hint: "Gasho サーバーの GASHO_ALLOW_NETS に、このマシンのネットワークを入れてください" }
          : { level: "ok", name: "Gasho サーバー", detail: "つながります" },
    );
  }

  const claude = await run(o.claudeBin, ["--version"]);
  checks.push(
    claude && claude !== "error"
      ? { level: "ok", name: "Claude Code", detail: claude.split("\n")[0] ?? claude }
      : { level: "fail", name: "Claude Code", detail: `${o.claudeBin} が見つかりません`, hint: "Claude Code を入れて、端末で一度 claude を起動してログインしてください（パスが違うときは GASHO_CLAUDE_BIN）" },
  );

  checks.push(
    (await terminalWorks())
      ? { level: "ok", name: "端末", detail: "セッションの端末を作れます" }
      : {
          level: "warn",
          name: "端末",
          detail: "作れません",
          hint: `Gasho からセッションを起動して指示を送るのに使います（ないと見るだけになります）。node-pty のビルド済みのモジュールがあるのは、Linux と macOS の x64・arm64 です（このマシンは ${process.platform}-${process.arch}）`,
        },
  );

  const git = await run("git", ["--version"]);
  checks.push(
    git
      ? { level: "ok", name: "git", detail: (versionOf(git) ?? []).join(".") }
      : { level: "warn", name: "git", detail: "ありません", hint: "ブランチグラフに使います" },
  );

  const gh = await run(o.ghBin, ["--version"]);
  if (!gh || gh === "error") {
    checks.push({ level: "warn", name: "GitHub CLI", detail: "ありません", hint: "GitHub プラグインの Issues と Pull requests と、新しいセッションの「GitHub から clone」に使います。gh を入れて gh auth login でログインしてください" });
  } else {
    const auth = await run(o.ghBin, ["auth", "status"]);
    const loggedIn = auth !== undefined && /Logged in to/i.test(auth);
    checks.push(
      loggedIn
        ? { level: "ok", name: "GitHub CLI", detail: `${(versionOf(gh) ?? []).join(".")}、ログイン済み` }
        : { level: "warn", name: "GitHub CLI", detail: "ログインしていません", hint: "GitHub プラグインの Issues と Pull requests と、新しいセッションの「GitHub から clone」に使います。gh auth login でログインしてください" },
    );
  }

  const settings = await fs.readFile(o.settingsFile, "utf8").catch(() => "");
  const hookEvents = installedHookEvents(settings, o.hookPort);
  checks.push(
    !settings.includes(hookUrl(o.hookPort))
      ? { level: "warn", name: "hooks", detail: "入っていません", hint: "通知（応答の完了、確認待ち）と、Gasho からの権限の確認への回答に使います。docs/daemon-setup.md の「通知を使う」を見てください" }
      : !hookEvents.includes("PermissionRequest")
        ? { level: "warn", name: "hooks", detail: "PermissionRequest が入っていません", hint: "Gasho から権限の確認に答えるのに使います。hooks install をもう一度実行してください" }
        : { level: "ok", name: "hooks", detail: `${o.settingsFile} に入っています` },
  );

  checks.push(
    (await listening(o.hookPort))
      ? { level: "ok", name: "daemon", detail: `動いています（127.0.0.1:${o.hookPort}）` }
      : { level: "warn", name: "daemon", detail: "動いていません", hint: `${DAEMON} run で動かすか、常駐させてください（${DAEMON} service install）` },
  );
  checks.push(await chromeHostCheck());
  const service = o.serviceFile ? await fs.readFile(o.serviceFile, "utf8").catch(() => undefined) : undefined;
  const serviceCheck = service === undefined ? undefined : serviceNodeCheck(service, DAEMON);
  if (serviceCheck) checks.push(serviceCheck);
  return checks;
}

/** The native messaging host through which the Claude extension in Chrome reaches Claude Code (Claude in Chrome). */
export const CHROME_HOST = "com.anthropic.claude_code_browser_extension.json";

/** The folders of NativeMessagingHosts of the browsers Claude in Chrome works with, on this platform, by name. */
export function nativeHostDirs(home: string = os.homedir(), platform: NodeJS.Platform = process.platform): [string, string][] {
  const mac = (...p: string[]) => path.join(home, "Library", "Application Support", ...p, "NativeMessagingHosts");
  const linux = (...p: string[]) => path.join(home, ".config", ...p, "NativeMessagingHosts");
  if (platform === "darwin") {
    return [
      ["Chrome", mac("Google", "Chrome")],
      ["Chromium", mac("Chromium")],
      ["Edge", mac("Microsoft Edge")],
      ["Brave", mac("BraveSoftware", "Brave-Browser")],
    ];
  }
  if (platform === "linux") {
    return [
      ["Chrome", linux("google-chrome")],
      ["Chromium", linux("chromium")],
      ["Edge", linux("microsoft-edge")],
      ["Brave", linux("BraveSoftware", "Brave-Browser")],
    ];
  }
  return [];
}

/**
 * Whether a Chrome on this machine can reach Claude Code (Claude in Chrome): the native messaging host's file, which
 * Claude Code writes the first time it starts with --chrome, in one of the browsers' folders, and the program it names.
 * Without one, Claude in Chrome still reaches a Chrome on another computer whose Claude extension is signed in to the
 * same claude.ai account, so a missing one is no warning. Whether the extension is installed cannot be seen from here.
 */
export async function chromeHostCheck(dirs: [string, string][] = nativeHostDirs()): Promise<Check> {
  const name = "Claude in Chrome";
  const why = "セッションが Chrome を操作して Web アプリを確かめるのに使います（gasho-daemon session fork --chrome）";
  if (dirs.length === 0) return { level: "warn", name, detail: `このマシン（${process.platform}）では確かめられません`, hint: why };
  const found: string[] = [];
  const broken: string[] = [];
  for (const [browser, dir] of dirs) {
    const text = await fs.readFile(path.join(dir, CHROME_HOST), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let program: unknown;
    try {
      program = (JSON.parse(text) as { path?: unknown }).path;
    } catch {
      program = undefined;
    }
    const runs = typeof program === "string" && (await fs.access(program, fs.constants.X_OK).then(() => true, () => false));
    (runs ? found : broken).push(browser);
  }
  if (found.length > 0) {
    return {
      level: "ok",
      name,
      detail: `${found.join("・")} の native messaging host があります（拡張機能が入っているかは、ここからは確かめられません）`,
    };
  }
  if (broken.length > 0) {
    return {
      level: "warn",
      name,
      detail: `${broken.join("・")} の native messaging host が起動するプログラムがありません`,
      hint: `${why}。端末で一度 claude --chrome を起動すると、作り直されます`,
    };
  }
  return {
    level: "ok",
    name,
    detail:
      "このマシンの Chrome にはつながりません（native messaging host なし）。同じ claude.ai アカウントでサインインした、別のコンピューターの Chrome の拡張機能にはつながります",
  };
}

/**
 * Whether the service's file runs Node.js from Homebrew's folder for one version (node-path.ts), which `brew upgrade`
 * removes; undefined when the file names no Node.js. `service install` writes a path that stays.
 */
export function serviceNodeCheck(text: string, command: string, stable: (node: string) => string = stableNode): Check | undefined {
  const node = serviceNode(text);
  if (!node) return undefined;
  if (!cellarNode(node)) return { level: "ok", name: "常駐の Node.js", detail: node };
  const better = stable(node);
  return {
    level: "warn",
    name: "常駐の Node.js",
    detail: `Homebrew の版ごとのフォルダーです（${node}）`,
    hint:
      better === node
        ? `brew upgrade node で消えると、daemon が起動できなくなります。${command} service install をもう一度実行してください（版が変わっても変わらないパスにします）`
        : `brew upgrade node で消えると、daemon が起動できなくなります。${command} service install をもう一度実行すると、${better} にします`,
  };
}

const MARK: Record<Check["level"], string> = { ok: "✓", warn: "!", fail: "✗" };

/** Columns a text takes in a terminal: CJK and other wide characters take two. */
function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return n;
}

export function formatChecks(checks: Check[], version: string): string {
  const width = Math.max(...checks.map((c) => columns(c.name))) + 2;
  const lines = [`gasho-daemon ${version} のセットアップの確認`, ""];
  for (const c of checks) {
    lines.push(`${MARK[c.level]} ${c.name}${" ".repeat(width - columns(c.name))}${c.detail}`);
    if (c.hint) lines.push(`    → ${c.hint}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push("", fails ? `✗ が ${fails} 件あります。直してから daemon を動かしてください。` : warns ? `daemon は動かせます。! の機能は、入れるまで使えません。` : "すべて揃っています。");
  return lines.join("\n");
}

// ---- keeping the daemon running ----

/** Where the daemon's own settings go (GASHO_HOOK_SECRET and the like); the daemon reads it when it starts. */
export const ENV_FILE = "~/.config/gasho/daemon.env";

export interface ServiceInput {
  /** The Node.js that runs the daemon (its folder goes first on PATH). */
  node: string;
  /** The command that runs gasho-daemon, before "run" (see serviceCommand in install.ts). */
  argv: string[];
  /** The folder it runs in: the repository's, or the home folder. */
  cwd: string;
  /** PATH for the daemon: Claude Code, gh and git must be found in it. */
  path: string;
  home: string;
}

/**
 * Folders npm puts first on PATH while it runs a command (npx, npm exec, npm run): the package's own bin folder in
 * npx's cache, node_modules/.bin of the folder it runs in and of each folder above it, and its node-gyp shim. They mean
 * nothing to a service, and npx's may be gone later.
 */
function addedByNpm(dir: string): boolean {
  return /(^|\/)node_modules\/\.bin\/?$/.test(dir) || dir.includes("/_npx/") || /\/node-gyp-bin\/?$/.test(dir);
}

/** The PATH the service gets: Node.js's folder first, then this shell's PATH (where claude and gh are found). */
export function servicePath(node: string, envPath: string | undefined): string {
  const dirs = [path.dirname(node), ...(envPath ?? "").split(":").filter((d) => !addedByNpm(d))].filter(Boolean);
  return [...new Set(dirs)].join(":");
}

const systemdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** A systemd user service (~/.config/systemd/user/gasho-daemon.service). */
export function systemdUnit(o: ServiceInput): string {
  return `[Unit]
Description=gasho-daemon (Gasho の working server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${o.cwd.replace(/%/g, "%%")}
ExecStart=${o.argv.map(systemdQuote).join(" ")} run
Environment=${systemdQuote(`PATH=${o.path}`)}
# GASHO_HOOK_SECRET などは、ここではなく ${ENV_FILE} に書く（gasho-daemon が起動するときに読む）
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The label of the launchd agent. */
export const LAUNCHD_LABEL = "local.gasho.daemon";

/** The name of the systemd user service. */
export const SYSTEMD_UNIT = "gasho-daemon.service";

/** Where `service install` writes the service's file: undefined on a system without systemd or launchd. */
export function serviceFile(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform === "linux") return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", SYSTEMD_UNIT);
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return undefined;
}

/** How long launchd's agent may take to go after `launchctl bootout`, in steps of LAUNCHD_POLL_S seconds (10 s). */
export const LAUNCHD_GONE_POLLS = 50;
const LAUNCHD_POLL_S = 0.2;
/** How many quiet tries of `launchctl bootstrap`, a second apart, come before its last one (whose error is shown). */
export const LAUNCHD_BOOTSTRAP_RETRIES = 5;

/**
 * launchd's commands that replace a loaded agent with the one in `file`: bootout (it may fail: the agent was not
 * loaded yet), then wait until launchd has let the agent go, then bootstrap. bootout can return while the old agent is
 * still being stopped, and a bootstrap then fails with "Bootstrap failed: 5: Input/output error" (#87). The wait ends
 * when `launchctl print` no longer finds the agent, or after LAUNCHD_GONE_POLLS; bootstrap is tried again a second
 * later when it fails anyway, quietly but for the last try. The scripts get their values as arguments, never quoted
 * into them. Shared with gasho-hub's (apps/hub/src/service.ts), which copies it.
 */
export function launchdReplaceCommands(label: string, file: string, uid: number): { argv: string[]; mayFail?: boolean }[] {
  const domain = `gui/${uid}`;
  const wait = `i=0; while launchctl print "$1" >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge ${LAUNCHD_GONE_POLLS} ] && exit 0; sleep ${LAUNCHD_POLL_S}; done`;
  const bootstrap = `n=0; until launchctl bootstrap "$1" "$2" 2>/dev/null; do n=$((n+1)); sleep 1; if [ "$n" -ge ${LAUNCHD_BOOTSTRAP_RETRIES} ]; then exec launchctl bootstrap "$1" "$2"; fi; done`;
  return [
    { argv: ["launchctl", "bootout", `${domain}/${label}`], mayFail: true },
    { argv: ["/bin/sh", "-c", wait, "sh", `${domain}/${label}`], mayFail: true },
    { argv: ["/bin/sh", "-c", bootstrap, "sh", domain, file] },
  ];
}

/**
 * The commands that make the service manager read the service's file again and start the daemon with it (stopping
 * the one it runs now).
 */
export function activateCommands(platform: NodeJS.Platform, file: string, uid: number): { argv: string[]; mayFail?: boolean }[] {
  if (platform === "darwin") return launchdReplaceCommands(LAUNCHD_LABEL, file, uid);
  const unit = SYSTEMD_UNIT.replace(/\.service$/, "");
  return [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", unit] },
    { argv: ["systemctl", "--user", "restart", unit] },
  ];
}

/** A launchd agent (~/Library/LaunchAgents/local.gasho.daemon.plist). */
export function launchdPlist(o: ServiceInput): string {
  const log = path.join(o.home, "Library/Logs/gasho-daemon.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...o.argv, "run"].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}
