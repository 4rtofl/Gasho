// Keeping the Gasho server running: a systemd user service on Linux (~/.config/systemd/user/gasho-hub.service), a
// launchd agent on macOS (~/Library/LaunchAgents/local.gasho.hub.plist). Modeled on gasho-daemon's (apps/daemon/src/
// setup.ts). The service runs the launcher of the layout (launcher.ts), which starts the version `current` links to;
// systemd starts it again when it ends with a failure (an update ends with 75), without giving up (a version that
// cannot listen yet is tried again rather than left down). Settings go in hub.env, never in the service's file.
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SYSTEMD_UNIT = "gasho-hub.service";
export const LAUNCHD_LABEL = "local.gasho.hub";
/** How the launcher marks the process it starts, for runAsService. */
export const LAUNCHER_ENV = "GASHO_HUB_LAUNCHER";

/** The Gasho server's own settings (GASHO_HUB_PORT and the like), read when it starts; a value set in the shell wins. */
export function envFileOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GASHO_HUB_ENV === "off") return undefined;
  return env.GASHO_HUB_ENV || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gasho", "hub.env");
}

/** Reads hub.env into the environment (process.loadEnvFile keeps what is set already). */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.error): void {
  const file = envFileOf(env);
  if (!file) return;
  try {
    process.loadEnvFile(file);
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") log(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ServiceInput {
  /** The Node.js that runs the Gasho server (its folder goes first on PATH). */
  node: string;
  /** What runs it: the launcher of the layout (or, from a clone, the clone's cli.ts), before "start". */
  argv: string[];
  /** The folder it runs in: the home folder, or the clone's. */
  cwd: string;
  /** PATH for the Gasho server: gh and npm must be found in it. */
  path: string;
  home: string;
}

/**
 * Folders npm puts first on PATH while it runs a command (npx, npm exec, npm run): they mean nothing to a service, and
 * npx's may be gone later.
 */
function addedByNpm(dir: string): boolean {
  return /(^|\/)node_modules\/\.bin\/?$/.test(dir) || dir.includes("/_npx/") || /\/node-gyp-bin\/?$/.test(dir);
}

/** The PATH the service gets: Node.js's folder first, then this shell's PATH (where gh is found). */
export function servicePath(node: string, envPath: string | undefined): string {
  const dirs = [path.dirname(node), ...(envPath ?? "").split(":").filter((d) => !addedByNpm(d))].filter(Boolean);
  return [...new Set(dirs)].join(":");
}

const systemdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * The systemd user service. StartLimitIntervalSec=0: systemd never gives up starting it; a known good version that
 * cannot bind its port yet keeps being tried instead of leaving Gasho down.
 */
export function systemdUnit(o: ServiceInput): string {
  return `[Unit]
Description=Gasho サーバー（gasho-hub）
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${o.cwd.replace(/%/g, "%%")}
ExecStart=${o.argv.map(systemdQuote).join(" ")} start
Environment=${systemdQuote(`PATH=${o.path}`)}
# GASHO_HUB_PORT などは、ここではなく ~/.config/gasho/hub.env に書く（Gasho サーバーが起動するときに読む）
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launchd agent: KeepAlive starts it again whenever it ends. */
export function launchdPlist(o: ServiceInput): string {
  const log = path.join(o.home, "Library/Logs/gasho-hub.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...o.argv, "start"].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
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

/** Where `service install` writes the service's file: undefined on a system without systemd or launchd. */
export function serviceFile(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform === "linux") return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", SYSTEMD_UNIT);
  if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return undefined;
}

/**
 * The commands that make the service manager read the service's file again, enable it, and (with `start`) start the
 * Gasho server with it, stopping the one it runs now. Without `start`, launchd's bootstrap is left for later: it starts
 * the agent at once.
 */
export function activateCommands(platform: NodeJS.Platform, file: string, uid: number, start: boolean): { argv: string[]; mayFail?: boolean }[] {
  if (platform === "darwin") {
    if (!start) return [];
    return [
      { argv: ["launchctl", "bootout", `gui/${uid}/${LAUNCHD_LABEL}`], mayFail: true },
      { argv: ["launchctl", "bootstrap", `gui/${uid}`, file] },
    ];
  }
  const unit = SYSTEMD_UNIT.replace(/\.service$/, "");
  return [
    { argv: ["systemctl", "--user", "daemon-reload"] },
    { argv: ["systemctl", "--user", "enable", unit] },
    ...(start ? [{ argv: ["systemctl", "--user", "restart", unit] }] : []),
  ];
}

/**
 * Whether the Gasho server runs as a service that starts it again when it ends: started by the launcher (which marks
 * the environment) under systemd (INVOCATION_ID, any unit: the trials run as another one) or launchd.
 */
export function runAsService(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env[LAUNCHER_ENV] !== "1") return false;
  if (platform === "linux") return Boolean(env.INVOCATION_ID);
  if (platform === "darwin") return Boolean(env.XPC_SERVICE_NAME);
  return false;
}

/** Whether something listens on host:port already (another Gasho server), by trying to listen there. */
export function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, host);
  });
}
