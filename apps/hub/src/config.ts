import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseNets } from "./netallow.ts";

export interface HubConfig {
  host: string;
  port: number;
  allowNets: string[];
  dbFile: string;
  webDist: string;
  /** The installed plugins, one folder (or link) each (docs/plugins.md). */
  pluginsDir: string;
  /** The checked versions of the plugins, served from here. */
  pluginCacheDir: string;
  /** The repository whose catalog plugins are added from ("owner/name"). */
  pluginRepo: string;
  /** The GitHub CLI that reads it, with its login. */
  ghBin: string;
}

export function pluginsDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.GASHO_PLUGINS_DIR ?? path.join(os.homedir(), ".local", "share", "gasho", "plugins");
}

export function dbFileOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.GASHO_DB ?? path.join(os.homedir(), ".local", "share", "gasho", "hub.db");
}

/**
 * The screen the Gasho server serves: GASHO_WEB_DIST, or, in the package (JavaScript in lib/), the build beside it
 * (web/), or, in a clone (TypeScript in apps/hub/src), apps/web/dist. Told apart by what runs, not by which folder is
 * there: a clone with a stray web/ folder still serves its own build.
 */
export function webDistOf(env: NodeJS.ProcessEnv = process.env, moduleUrl = import.meta.url): string {
  if (env.GASHO_WEB_DIST) return env.GASHO_WEB_DIST;
  const here = path.dirname(fileURLToPath(moduleUrl));
  return moduleUrl.endsWith(".js") ? path.resolve(here, "../web") : path.resolve(here, "../../web/dist");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    // Listens on the LAN by default; GASHO_ALLOW_NETS decides which source addresses are served.
    host: env.GASHO_HUB_HOST ?? "0.0.0.0",
    port: Number(env.GASHO_HUB_PORT ?? 7740),
    allowNets: parseNets(env.GASHO_ALLOW_NETS),
    dbFile: dbFileOf(env),
    webDist: webDistOf(env),
    pluginsDir: pluginsDirOf(env),
    pluginCacheDir: env.GASHO_PLUGIN_CACHE ?? path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "gasho", "hub-plugins"),
    pluginRepo: env.GASHO_PLUGIN_REPO || "4rtoflow/GashoPlugins",
    ghBin: env.GASHO_GH_BIN || "gh",
  };
}
