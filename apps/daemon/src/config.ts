import os from "node:os";
import path from "node:path";
import { claudeTmpRoot } from "./claude-tmp.ts";
import { credentialsPath, daemonUrl, type Credentials } from "./credentials.ts";
import { TRIAL_MAX_MS, TRIAL_MS } from "./self-update.ts";

export interface DaemonConfig {
  hubUrl: string;
  machineId: string;
  token: string;
  hookPort: number;
  hookSecret: string | undefined;
  claudeDir: string;
  claudeBin: string;
  /** The GitHub CLI, used with its own login to clone a repository for a new session (folders.ts). */
  ghBin: string;
  pollIntervalMs: number;
  /** Where the daemon keeps its own files (managed sessions); next to the registration. */
  stateDir: string;
  /** Files sent with inputs, one folder per session; Claude reads them from here. */
  attachmentsDir: string;
  /** Given to the Claude Codes that Gasho starts as CLAUDE_CODE_TMPDIR (claude-tmp.ts). */
  claudeTmpDir: string;
  /** The code of the plugins' daemon parts, as the Gasho server handed it over (docs/plugins.md). */
  pluginCacheDir: string;
  /** The daemon parts' own files, one folder per plugin; kept when a plugin is updated or removed. */
  pluginDataDir: string;
  /** False when GASHO_PLUGINS=none: no plugin's daemon part runs on this working server. */
  runPlugins: boolean;
  /** How long a version started by an update is on trial (self-update.ts). */
  trialMs: number;
}

export function loadConfig(creds: Credentials, env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const stateDir = path.dirname(credentialsPath(env));
  return {
    hubUrl: env.GASHO_HUB_URL ?? daemonUrl(creds.server),
    machineId: creds.machineId,
    token: creds.token,
    hookPort: Number(env.GASHO_HOOK_PORT ?? 7741),
    hookSecret: env.GASHO_HOOK_SECRET || undefined,
    claudeDir: env.GASHO_CLAUDE_DIR ?? path.join(os.homedir(), ".claude"),
    claudeBin: env.GASHO_CLAUDE_BIN ?? "claude",
    ghBin: env.GASHO_GH_BIN ?? "gh",
    pollIntervalMs: Number(env.GASHO_POLL_MS ?? 3000),
    stateDir,
    attachmentsDir: path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "gasho", "attachments"),
    claudeTmpDir: claudeTmpRoot(stateDir, env),
    pluginCacheDir: path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "gasho", "daemon-plugins"),
    pluginDataDir: path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "gasho", "plugin-data"),
    runPlugins: env.GASHO_PLUGINS !== "none",
    trialMs: msUpTo(env.GASHO_DAEMON_PROBATION_MS, TRIAL_MAX_MS) ?? TRIAL_MS,
  };
}

/**
 * A length of time in milliseconds set in the environment, when it is one up to `max`: empty or not a number would be
 * none at all, and setTimeout takes one over about 24 days for 1 ms.
 */
function msUpTo(value: string | undefined, max: number): number | undefined {
  const n = Number(value);
  return value && n > 0 && n <= max ? n : undefined;
}
