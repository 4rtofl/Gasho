// The skills and custom commands that a session's Claude Code takes after "/", read where Claude Code reads them
// (code.claude.com/docs/en/skills and …/plugins-reference): the person's ~/.claude, the session's folder and those
// above it up to the top of its repository, the enabled plugins, and the skills synced from claude.ai. Claude Code's
// built-in commands and bundled skills are inside Claude Code, so they are not here.
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionWorktree, SkillInfo } from "@gasho/protocol";
import { isInside } from "./statusline.ts";

/**
 * Synced skills always answer to this prefix. Their bare name answers too, unless another command has it, and that
 * can be one of Claude Code's own (a synced "help" and the built-in /help).
 */
const SYNCED_PREFIX = "anthropic-skills:";
/** What is read of a SKILL.md or a command file: enough for its frontmatter and the start of its text. */
const HEAD_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 200;
const MAX_SKILLS = 1000;
/** How deep the folders of a commands folder are read ("a/b/c.md" is /a:b:c). */
const MAX_COMMAND_DEPTH = 3;

export interface SkillPlaces {
  /** ~/.claude */
  claudeDir: string;
  /** ~/.claude.json, which names the claude.ai account whose synced skills are used. */
  claudeJson: string;
  /** The session's folder. */
  cwd: string;
  worktree?: SessionWorktree;
}

/** A skill or a command file as read: the name its frontmatter gives, its description, whether "/" offers it. */
interface Entry {
  name?: string;
  description?: string;
  invocable: boolean;
}

type Settings = Record<string, unknown>;

/** What can be typed after "/" in a session's Claude Code, by name. */
export async function listSkills(p: SkillPlaces): Promise<SkillInfo[]> {
  const settings = await Promise.all(
    [path.join(p.claudeDir, "settings.json"), path.join(p.cwd, ".claude", "settings.json"), path.join(p.cwd, ".claude", "settings.local.json")].map(readJson),
  );
  // Later files win, key by key: the folder's local settings over its shared ones over the person's.
  const merged = (key: string): Record<string, unknown> =>
    Object.assign({}, ...settings.map((s) => (isObject(s?.[key]) ? s[key] : {})));
  const overrides = merged("skillOverrides");
  const enabled = merged("enabledPlugins");

  const projects = projectDirs(p.cwd, p.worktree);
  const skillDirs = projects.map((d) => path.join(d, ".claude", "skills"));
  // A linked worktree without skills of its own at its top gets those of the repository's main checkout.
  const wt = p.worktree;
  if (wt && wt.path !== wt.repo && projects.includes(path.resolve(wt.path)) && !(await isDir(path.join(wt.path, ".claude", "skills")))) {
    skillDirs.push(path.join(wt.repo, ".claude", "skills"));
  }

  const [personal, project, personalCommands, projectCommands, plugins, synced] = await Promise.all([
    skillsIn(path.join(p.claudeDir, "skills"), new Set(["synced"])),
    Promise.all(skillDirs.map((d) => skillsIn(d))).then((x) => x.flat()),
    commandsIn(path.join(p.claudeDir, "commands")),
    Promise.all(projects.map((d) => commandsIn(path.join(d, ".claude", "commands")))).then((x) => x.flat()),
    pluginSkills(p, enabled),
    syncedSkills(p),
  ]);

  // The first of a name is the one Claude Code runs: a personal skill over a project one, a skill over a command file.
  const out: SkillInfo[] = [];
  const taken = new Set<string>();
  const add = (names: (string | undefined)[], e: Entry, overridable: boolean) => {
    const name = names.find((n): n is string => n !== undefined && !taken.has(n));
    if (name === undefined) return;
    taken.add(name);
    if (!e.invocable) return;
    // skillOverrides name skills without a plugin's prefix (and plugins are not subject to them).
    if (overridable && overrides[name.startsWith(SYNCED_PREFIX) ? name.slice(SYNCED_PREFIX.length) : name] === "off") return;
    out.push(e.description ? { name, description: e.description } : { name });
  };
  // In a folder of skills, the frontmatter's name is the command; the folder's name also runs it.
  for (const s of [...personal, ...project]) add([s.name, s.dir], s, true);
  for (const c of [...personalCommands, ...projectCommands]) add([c.command], c, true);
  for (const s of plugins) add([s.command], s, false);
  for (const s of synced) add([s.command], s, true);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, MAX_SKILLS);
}

/** The session's folder and those above it, up to the top of its worktree (only the folder, outside a repository). */
function projectDirs(cwd: string, worktree: SessionWorktree | undefined): string[] {
  const top = worktree && isInside(cwd, worktree.path) ? path.resolve(worktree.path) : path.resolve(cwd);
  const dirs: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    dirs.push(d);
    if (d === top || path.dirname(d) === d) return dirs;
  }
}

/** The skills of a skills folder (`<name>/SKILL.md`), with their folder's name. */
async function skillsIn(dir: string, skip?: Set<string>): Promise<(Entry & { dir: string })[]> {
  const names = (await namesIn(dir)).filter((n) => !skip?.has(n) && validName(n));
  const read = await Promise.all(names.map(async (n) => ({ n, e: await readEntry(path.join(dir, n, "SKILL.md")) })));
  return read.flatMap(({ n, e }) => (e ? [{ ...e, dir: n }] : []));
}

/** The command files of a commands folder: "deploy.md" is /deploy, "frontend/component.md" /frontend:component. */
async function commandsIn(dir: string, nested = true, prefix = "", depth = 0): Promise<(Entry & { command: string })[]> {
  const names = await namesIn(dir);
  const read = await Promise.all(
    names.map(async (n): Promise<(Entry & { command: string })[]> => {
      const file = path.join(dir, n);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat?.isDirectory()) return nested && depth < MAX_COMMAND_DEPTH && validName(n) ? commandsIn(file, nested, `${prefix}${n}:`, depth + 1) : [];
      const base = n.endsWith(".md") ? n.slice(0, -3) : undefined;
      if (!stat?.isFile() || !base || !validName(base)) return [];
      const e = await readEntry(file);
      return e ? [{ ...e, command: `${prefix}${base}` }] : [];
    }),
  );
  return read.flat();
}

interface PluginManifest {
  name?: unknown;
  skills?: unknown;
  commands?: unknown;
  defaultEnabled?: unknown;
}

/** The skills and commands of the plugins Claude Code loads in the session's folder, as "<plugin>:<name>". */
async function pluginSkills(p: SkillPlaces, enabled: Record<string, unknown>): Promise<(Entry & { command: string })[]> {
  const installed = await readJson(path.join(p.claudeDir, "plugins", "installed_plugins.json"));
  const plugins = isObject(installed?.plugins) ? installed.plugins : {};
  const here = new Set([path.resolve(p.cwd), ...(p.worktree ? [path.resolve(p.worktree.path)] : [])]);
  const read = await Promise.all(
    Object.entries(plugins).map(async ([id, installs]) => {
      if (!Array.isArray(installs)) return [];
      const ofHere = (i: unknown) =>
        isObject(i) && (i.scope === "project" || i.scope === "local") && typeof i.projectPath === "string" && here.has(path.resolve(i.projectPath));
      const install: unknown = installs.find(ofHere) ?? installs.find((i) => isObject(i) && (i.scope === "user" || i.scope === "managed"));
      if (!isObject(install) || typeof install.installPath !== "string") return [];
      const root = path.resolve(install.installPath);
      const manifest = ((await readJson(path.join(root, ".claude-plugin", "plugin.json"))) ?? {}) as PluginManifest;
      if ((enabled[id] ?? manifest.defaultEnabled ?? true) !== true) return [];
      const name = typeof manifest.name === "string" && validName(manifest.name) ? manifest.name : id.split("@")[0];
      if (!name || !validName(name)) return [];
      const [skills, commands] = await Promise.all([pluginSkillEntries(root, manifest, name), pluginCommandEntries(root, manifest)]);
      return [
        ...skills.map((s) => ({ ...s, command: s.name?.startsWith(`${name}:`) ? s.name : `${name}:${s.name ?? s.dir}` })),
        ...commands.map((c) => ({ ...c, command: `${name}:${c.command}` })),
      ];
    }),
  );
  return read.flat();
}

/**
 * A plugin's skills: its `skills/` folder, the folders its manifest adds (each a folder of skills or one skill), or
 * the plugin itself when it is one SKILL.md. A folder's name that the "/" menu cannot show has those characters as "-".
 */
async function pluginSkillEntries(root: string, manifest: PluginManifest, plugin: string): Promise<(Entry & { dir: string })[]> {
  const listed = pathsOf(root, manifest.skills);
  const defaultDir = path.join(root, "skills");
  if (listed.length === 0 && !(await isDir(defaultDir))) {
    const e = await readEntry(path.join(root, "SKILL.md"));
    return e ? [{ ...e, dir: plugin }] : [];
  }
  const read = await Promise.all(
    [defaultDir, ...listed.filter((d) => d !== defaultDir)].map(async (dir) => {
      const one = await readEntry(path.join(dir, "SKILL.md"));
      if (one) return [{ ...one, dir: dir === root ? plugin : path.basename(dir) }];
      const names = await namesIn(dir);
      const all = await Promise.all(names.map(async (n) => ({ n, e: await readEntry(path.join(dir, n, "SKILL.md")) })));
      return all.flatMap(({ n, e }) => (e ? [{ ...e, dir: n.replace(new RegExp(REFUSED_CHAR.source, "gu"), "-") }] : []));
    }),
  );
  return read.flat();
}

/** A plugin's commands: its `commands/` folder (its files, not its folders), or what its manifest names instead. */
async function pluginCommandEntries(root: string, manifest: PluginManifest): Promise<(Entry & { command: string })[]> {
  const declared = manifest.commands;
  if (isObject(declared) && !Array.isArray(declared)) {
    const read = await Promise.all(
      Object.entries(declared).map(async ([command, spec]) => {
        if (!validName(command) || !isObject(spec)) return [];
        const file = typeof spec.source === "string" ? pathsOf(root, spec.source)[0] : undefined;
        const e = file ? await readEntry(file) : typeof spec.content === "string" ? entryOf(spec.content) : undefined;
        if (!e) return [];
        return [{ ...e, command, description: typeof spec.description === "string" ? oneLine(spec.description) : e.description }];
      }),
    );
    return read.flat();
  }
  const listed = declared === undefined ? [path.join(root, "commands")] : pathsOf(root, declared);
  const read = await Promise.all(
    listed.map(async (p) => {
      if (await isDir(p)) return commandsIn(p, false);
      const base = path.basename(p, ".md");
      const e = p.endsWith(".md") && validName(base) ? await readEntry(p) : undefined;
      return e ? [{ ...e, command: base }] : [];
    }),
  );
  return read.flat();
}

/** The skills synced from the claude.ai account Claude Code is signed in with, as "anthropic-skills:<name>". */
async function syncedSkills(p: SkillPlaces): Promise<(Entry & { command: string })[]> {
  const account = (await readJson(p.claudeJson))?.oauthAccount;
  if (!isObject(account) || typeof account.organizationUuid !== "string" || typeof account.accountUuid !== "string") return [];
  const folder = `${account.organizationUuid}_${account.accountUuid}`;
  if (!validName(folder)) return [];
  const skills = await skillsIn(path.join(p.claudeDir, "skills", "synced", folder));
  return skills.map((s) => ({ ...s, command: `${SYNCED_PREFIX}${s.name ?? s.dir}` }));
}

/** The manifest's paths (one, or several) inside the plugin's folder; those outside it are not loaded. */
function pathsOf(root: string, value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return list.map((v) => path.resolve(root, v)).filter((p) => isInside(p, root));
}

/** A SKILL.md or a command file, or undefined when there is none. */
async function readEntry(file: string): Promise<Entry | undefined> {
  const text = await readHead(file);
  return text === undefined ? undefined : entryOf(text);
}

function entryOf(text: string): Entry {
  const { fields, body } = frontmatter(text);
  // Without a description, Claude Code uses the first line of the text.
  const first = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  const name = fields.get("name");
  const description = oneLine(fields.get("description") || first);
  return {
    ...(name && validName(name) ? { name } : {}),
    ...(description ? { description } : {}),
    invocable: !/^(false|no|off|0)$/i.test(fields.get("user-invocable") ?? ""),
  };
}

/**
 * The top-level keys of a Markdown file's frontmatter (from a first line "---" to the next), each value as one line of
 * text: a quoted string, a block scalar ("|", ">") or a plain value over several lines. Nested values come as text.
 */
export function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const end = lines[0]?.trimEnd() === "---" ? lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l)) : -1;
  if (end < 0) return { fields: new Map(), body: text };
  const fields = new Map<string, string>();
  const line = (i: number) => lines[i] ?? "";
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/.exec(line(i));
    if (!m?.[1]) continue;
    const first = (m[2] ?? "").trim();
    const more: string[] = [];
    while (i + 1 < end && (/^\s/.test(line(i + 1)) || line(i + 1).trim() === "")) more.push(line(++i).trim());
    let value: string;
    if (/^[|>][+-]?\d*(\s+#.*)?$/.test(first)) value = more.join(" ");
    else if (first.startsWith('"')) value = doubleQuoted([first, ...more].join(" "));
    else if (first.startsWith("'")) value = [first, ...more].join(" ").replace(/^'|'$/g, "").replaceAll("''", "'");
    else value = [first, ...more].join(" ");
    fields.set(m[1], value.replace(/\s+/g, " ").trim());
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

function doubleQuoted(s: string): string {
  try {
    const v: unknown = JSON.parse(s);
    if (typeof v === "string") return v;
  } catch {
    // YAML escapes that JSON does not take: shown as written.
  }
  return s.replace(/^"|"$/g, "");
}

function oneLine(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_DESCRIPTION ? `${t.slice(0, MAX_DESCRIPTION - 1)}…` : t;
}

/** Characters Claude Code refuses in a command's name (blanks too: a name with them cannot be typed as one word). */
const REFUSED_CHAR = /[\s<>\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;

function validName(n: string): boolean {
  return n.length > 0 && n.length <= 200 && !n.startsWith(".") && !REFUSED_CHAR.test(n);
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  return (await fs.stat(p).catch(() => undefined))?.isDirectory() === true;
}

/** The start of a file, or undefined when it is not a file that can be read. */
async function readHead(file: string): Promise<string | undefined> {
  // A FIFO would block the open: only regular files are opened.
  if (!(await fs.stat(file).catch(() => undefined))?.isFile()) return undefined;
  let h: fs.FileHandle | undefined;
  try {
    h = await fs.open(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await h.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await h?.close();
  }
}

async function readJson(file: string): Promise<Settings | undefined> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
