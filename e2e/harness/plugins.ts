// Plugins for the tests: a folder of a plugin's built files (gasho-plugin.json, web.js, …), put in the Gasho server's
// plugins folder while it runs, as `gasho-hub plugin add` does (a link, or a copy), or released as GashoPlugins' Actions
// do (a .tgz and its entry of the catalog, which the fake gh hands out). The Gasho server watches its plugins folder, so
// what changes there reaches the open screens at once (hot reload).
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import type { CatalogPlugin, PluginManifest } from "@gasho/protocol";
import { PLUGIN_API } from "../../apps/hub/src/plugins.ts";
import { catalogAnswer, type FakeAnswer } from "./fakes.ts";
import type { GashoHub } from "./hub.ts";
import { GASHO_DIR } from "./process.ts";

/** The plugins written for the tests of this checkout (e2e/plugins/<id>/). */
export const TEST_PLUGINS = path.join(GASHO_DIR, "e2e/plugins");

/** The Gasho server's plugins folder (GASHO_PLUGINS_DIR, as startHub sets it). */
export function pluginsDir(hub: GashoHub): string {
  return path.join(hub.root, "hub", "plugins");
}

/**
 * Writes files of a plugin's folder, and gasho-plugin.json after them: the Gasho server takes a linked folder whose
 * gasho-plugin.json is older than another file for one being built (`building` in apps/hub/src/plugins.ts).
 */
export async function writePlugin(dir: string, o: { manifest?: PluginManifest; files?: Record<string, string> }): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(o.files ?? {})) {
    await fsp.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fsp.writeFile(path.join(dir, name), text);
  }
  const file = path.join(dir, "gasho-plugin.json");
  const manifest = o.manifest ?? (JSON.parse(await fsp.readFile(file, "utf8")) as PluginManifest);
  await fsp.writeFile(file, JSON.stringify(manifest, null, 2));
}

/** A copy of a plugin of e2e/plugins in the test's folder, which the test may change. */
export async function copyTestPlugin(hub: GashoHub, name: string, change?: (m: PluginManifest) => PluginManifest): Promise<string> {
  const to = path.join(hub.root, "src", name);
  await fsp.cp(path.join(TEST_PLUGINS, name), to, { recursive: true });
  if (change) await writePlugin(to, { manifest: change(JSON.parse(await fsp.readFile(path.join(to, "gasho-plugin.json"), "utf8")) as PluginManifest) });
  return to;
}

async function idOf(dir: string): Promise<string> {
  return (JSON.parse(await fsp.readFile(path.join(dir, "gasho-plugin.json"), "utf8")) as PluginManifest).id;
}

/** Puts a plugin in the plugins folder: a link to `dir` (one being developed), or a copy. Made aside, then moved in. */
export async function addPlugin(hub: GashoHub, dir: string, o: { link?: boolean } = {}): Promise<string> {
  const id = await idOf(dir);
  const plugins = pluginsDir(hub);
  await fsp.mkdir(plugins, { recursive: true });
  // The Gasho server reads no folder whose name starts with ".".
  const tmp = path.join(plugins, `.${id}-e2e`);
  if (o.link) await fsp.symlink(await fsp.realpath(dir), tmp);
  else await fsp.cp(dir, tmp, { recursive: true });
  await fsp.rename(tmp, path.join(plugins, id));
  return id;
}

/** One file of a tar archive (ustar). */
function tarEntry(name: string, data: Buffer): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

export interface PluginRelease {
  /** The plugin's entry of catalog.json. */
  entry: CatalogPlugin;
  /** The fake gh's answer to `gh release download <release> … --pattern <file>`. */
  answer: FakeAnswer;
}

/**
 * The release of a plugin's folder as GashoPlugins' Actions make it (<id>-<version>.tgz in the release
 * <id>-v<version>), written in the test's folder.
 */
export async function releasePlugin(hub: GashoHub, dir: string, o: { genre?: string; delayMs?: number; repo?: string } = {}): Promise<PluginRelease> {
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, "gasho-plugin.json"), "utf8")) as PluginManifest;
  const names = (await fsp.readdir(dir, { recursive: true, withFileTypes: true })).filter((d) => d.isFile()).map((d) => path.relative(dir, path.join(d.parentPath, d.name)));
  const tgz = zlib.gzipSync(Buffer.concat([...(await Promise.all(names.sort().map(async (n) => tarEntry(n, await fsp.readFile(path.join(dir, n)))))), Buffer.alloc(1024)]));
  const release = `${manifest.id}-v${manifest.version}`;
  const file = `${manifest.id}-${manifest.version}.tgz`;
  const out = path.join(hub.root, "releases", release, file);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, tgz);
  const entry: CatalogPlugin = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...((o.genre ?? manifest.genre) ? { genre: o.genre ?? manifest.genre } : {}),
    api: manifest.api,
    ...(manifest.permissions ? { permissions: manifest.permissions } : {}),
    daemon: Boolean(manifest.daemon),
    release,
    file,
    sha256: createHash("sha256").update(tgz).digest("hex"),
    size: tgz.length,
  };
  return {
    entry,
    answer: { args: ["release", "download", release, "--repo", o.repo ?? "4rtofl/GashoPlugins", "--pattern", file], outputFile: out, ...(o.delayMs ? { delayMs: o.delayMs } : {}) },
  };
}

/** An entry of the catalog that only shows on the plugins screen: there is no release behind it. */
export function listedPlugin(o: Partial<CatalogPlugin> & { id: string }): CatalogPlugin {
  const version = o.version ?? "1.0.0";
  return { name: o.id, api: PLUGIN_API, daemon: false, release: `${o.id}-v${version}`, file: `${o.id}-${version}.tgz`, sha256: "0".repeat(64), size: 1, ...o, version };
}

/** The fake gh's answers for a catalog of these releases (and plugins only listed), and for downloading each release. */
export function catalogWith(o: { releases?: PluginRelease[]; plugins?: CatalogPlugin[]; genres?: { id: string; name: string }[] }): FakeAnswer[] {
  const releases = o.releases ?? [];
  return [
    catalogAnswer({ repo: "4rtofl/GashoPlugins", ...(o.genres ? { genres: o.genres } : {}), plugins: [...releases.map((r) => r.entry), ...(o.plugins ?? [])] }),
    ...releases.map((r) => r.answer),
  ];
}
