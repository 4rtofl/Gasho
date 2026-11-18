import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_TMP_MAX_AGE_MS, claudeTmpRoot, removeSessionTmp, sessionTmpDirs, sweepClaudeTmp } from "../src/claude-tmp.ts";
import { loadConfig } from "../src/config.ts";

const UID = 1000;
const A = "0b4d15fc-2468-4535-a574-5db3ba695366";
const B = "8b2865d0-3f0c-4a4c-9e0c-14092681530e";
const C = "e2f97bb2-a44c-41b3-a9a6-24b4ade72272";
const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const nobody = () => false;

async function tmp() {
  // Under the system's temporary folder only for the length of a test, and a few small files.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gasho-claude-tmp-")));
  const root = path.join(dir, "root");
  const project = path.join(root, `claude-${UID}`, "-home-rg-repo");
  await fs.mkdir(project, { recursive: true });
  return { dir, root, project, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Sets the time of a folder and all that is in it. */
async function age(dir: string, at: number): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await age(file, at);
    else await fs.lutimes(file, new Date(at), new Date(at));
  }
  await fs.lutimes(dir, new Date(at), new Date(at));
}

/** A session's folder as Claude Code leaves it, last changed at `at`. */
async function session(project: string, id: string, at: number): Promise<string> {
  const dir = path.join(project, id);
  await fs.mkdir(path.join(dir, "scratchpad"), { recursive: true });
  await fs.mkdir(path.join(dir, "tasks"));
  await fs.writeFile(path.join(dir, "scratchpad", "note.txt"), "x");
  await age(dir, at);
  return dir;
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

test("the folder is in the one chosen with an absolute path, or in gasho's in the cache folder", () => {
  const own = path.basename(claudeTmpRoot("/state", {}));
  assert.match(own, /^[0-9a-f]{12}$/);
  assert.equal(claudeTmpRoot("/state", { GASHO_CLAUDE_TMPDIR: "/data/tmp/", XDG_CACHE_HOME: "/c" }), `/data/tmp/${own}`);
  assert.equal(claudeTmpRoot("/state", { XDG_CACHE_HOME: "/c" }), `/c/gasho/claude-tmp/${own}`);
  assert.equal(claudeTmpRoot("/state", { GASHO_CLAUDE_TMPDIR: "relative/tmp", XDG_CACHE_HOME: "/c" }), `/c/gasho/claude-tmp/${own}`);
  assert.equal(claudeTmpRoot("/state", { GASHO_CLAUDE_TMPDIR: "", XDG_CACHE_HOME: "/c" }), `/c/gasho/claude-tmp/${own}`);
  assert.equal(claudeTmpRoot("/state", {}), path.join(os.homedir(), ".cache", "gasho", "claude-tmp", own));
});

test("a daemon with another state folder has another folder, and its clean-up leaves the first one's sessions alone", async () => {
  const { root, done } = await tmp();
  try {
    for (const env of [{ XDG_CACHE_HOME: root }, { XDG_CACHE_HOME: "/c", GASHO_CLAUDE_TMPDIR: root }]) {
      const creds = { server: "http://127.0.0.1:1", machineId: "m", token: "t", name: "" };
      const first = loadConfig(creds, { ...env, GASHO_DAEMON_CONFIG: "/state/one/daemon.json" }).claudeTmpDir;
      const second = loadConfig(creds, { ...env, GASHO_DAEMON_CONFIG: "/state/two/daemon.json" }).claudeTmpDir;
      assert.notEqual(first, second);
      assert.equal(loadConfig(creds, { ...env, GASHO_DAEMON_CONFIG: "/state/one/other.json" }).claudeTmpDir, first);

      const running = await session(path.join(first, `claude-${UID}`, "-home-rg-app"), A, NOW - 100 * HOUR);
      const left = await session(path.join(second, `claude-${UID}`, "-home-rg-app"), B, NOW - 100 * HOUR);
      const { removed } = await sweepClaudeTmp(second, { keep: nobody, now: NOW, uid: UID });
      assert.deepEqual(removed, [left]);
      assert.equal(await fs.lstat(running).then(() => true, () => false), true);
    }
  } finally {
    await done();
  }
});

test("removing a session removes its folder in every working folder, and nothing else", async () => {
  const { root, project, done } = await tmp();
  try {
    const other = path.join(root, `claude-${UID}`, "-home-rg-other");
    const mine = await session(project, A, NOW);
    const moved = await session(other, A, NOW);
    const kept = await session(project, B, NOW);
    assert.deepEqual((await removeSessionTmp(root, A, UID)).sort(), [mine, moved].sort());
    assert.equal(await exists(mine), false);
    assert.equal(await exists(moved), false);
    assert.equal(await exists(kept), true);
  } finally {
    await done();
  }
});

test("only a session's id is looked for: a path in its place finds nothing", async () => {
  const { root, project, done } = await tmp();
  try {
    await session(project, A, NOW);
    for (const id of ["..", "../..", `../${A}`, "", "*", A.toUpperCase()]) assert.deepEqual(await sessionTmpDirs(root, id, UID), []);
    assert.equal(await exists(path.join(project, A)), true);
  } finally {
    await done();
  }
});

test("a symbolic link is not followed, at any level", async () => {
  const { dir, root, project, done } = await tmp();
  try {
    const outside = path.join(dir, "outside");
    const precious = await session(outside, A, NOW);
    // In place of the session's folder, of the working folder, and of claude-<uid>.
    await fs.symlink(precious, path.join(project, A));
    assert.deepEqual(await removeSessionTmp(root, A, UID), []);
    await fs.rm(path.join(project, A));
    await fs.symlink(outside, path.join(root, `claude-${UID}`, "-link"));
    assert.deepEqual(await removeSessionTmp(root, A, UID), []);
    const other = path.join(dir, "other-root");
    await fs.mkdir(other);
    await fs.symlink(outside, path.join(other, `claude-${UID}`));
    assert.deepEqual(await removeSessionTmp(other, A, UID), []);
    assert.deepEqual((await sweepClaudeTmp(other, { keep: nobody, now: NOW + 365 * 24 * HOUR, uid: UID })).removed, []);
    assert.equal(await exists(path.join(precious, "scratchpad", "note.txt")), true);
  } finally {
    await done();
  }
});

test("a link inside a session's folder is removed, and what it points to stays", async () => {
  const { dir, root, project, done } = await tmp();
  try {
    const outside = path.join(dir, "outside.txt");
    await fs.writeFile(outside, "keep");
    const mine = await session(project, A, NOW);
    await fs.symlink(outside, path.join(mine, "scratchpad", "link"));
    await removeSessionTmp(root, A, UID);
    assert.equal(await exists(mine), false);
    assert.equal(await fs.readFile(outside, "utf8"), "keep");
  } finally {
    await done();
  }
});

test("the clean-up removes what has not changed for 72 hours, and keeps what has", async () => {
  const { root, project, done } = await tmp();
  try {
    const old = await session(project, A, NOW - CLAUDE_TMP_MAX_AGE_MS - HOUR);
    const recent = await session(project, B, NOW - CLAUDE_TMP_MAX_AGE_MS + HOUR);
    // Old itself, but with one file written lately, deep inside.
    const touched = await session(project, C, NOW - CLAUDE_TMP_MAX_AGE_MS - HOUR);
    await fs.lutimes(path.join(touched, "scratchpad", "note.txt"), new Date(NOW - HOUR), new Date(NOW - HOUR));
    const { removed, failed } = await sweepClaudeTmp(root, { keep: nobody, now: NOW, uid: UID });
    assert.deepEqual(removed, [old]);
    assert.deepEqual(failed, []);
    assert.equal(await exists(recent), true);
    assert.equal(await exists(touched), true);
  } finally {
    await done();
  }
});

test("the empty folder Claude Code makes at each start, under an id no session uses, goes after 72 hours too", async () => {
  const { root, project, done } = await tmp();
  try {
    const dir = path.join(project, B);
    await fs.mkdir(path.join(dir, "scratchpad"), { recursive: true });
    await age(dir, NOW - CLAUDE_TMP_MAX_AGE_MS + HOUR);
    assert.deepEqual((await sweepClaudeTmp(root, { keep: nobody, now: NOW, uid: UID })).removed, []);
    await age(dir, NOW - CLAUDE_TMP_MAX_AGE_MS - HOUR);
    assert.deepEqual((await sweepClaudeTmp(root, { keep: nobody, now: NOW, uid: UID })).removed, [dir]);
  } finally {
    await done();
  }
});

test("the clean-up keeps the folder of a session in use, however old", async () => {
  const { root, project, done } = await tmp();
  try {
    const running = await session(project, A, NOW - 30 * 24 * HOUR);
    const { removed } = await sweepClaudeTmp(root, { keep: (id) => id === A, now: NOW, uid: UID });
    assert.deepEqual(removed, []);
    assert.equal(await exists(running), true);
  } finally {
    await done();
  }
});

test("a session opened again while its folder is being read is kept", async () => {
  const { root, project, done } = await tmp();
  try {
    const dir = await session(project, A, NOW - 30 * 24 * HOUR);
    let asked = 0;
    const { removed } = await sweepClaudeTmp(root, { keep: () => ++asked > 1, now: NOW, uid: UID });
    assert.deepEqual(removed, []);
    assert.equal(asked, 2);
    assert.equal(await exists(dir), true);
  } finally {
    await done();
  }
});

test("the clean-up touches only sessions' folders in claude-<uid> of the folder it is given", async () => {
  const { dir, root, project, done } = await tmp();
  try {
    const long = NOW + 365 * 24 * HOUR;
    // Another user's, one beside claude-<uid>, one with another name, a file, and a folder outside.
    const others = [
      await session(path.join(root, "claude-1001", "-home-x"), A, NOW),
      await session(path.join(root, "not-claude"), A, NOW),
      await session(path.join(dir, "outside"), A, NOW),
    ];
    const named = path.join(project, "not-a-session");
    await fs.mkdir(named);
    const file = path.join(project, C);
    await fs.writeFile(file, "x");
    assert.deepEqual((await sweepClaudeTmp(root, { keep: nobody, now: long, uid: UID })).removed, []);
    for (const f of [...others, named, file]) assert.equal(await exists(f), true, f);
  } finally {
    await done();
  }
});

test("a folder that does not exist yet is nothing to clean up", async () => {
  const { dir, done } = await tmp();
  try {
    assert.deepEqual(await sweepClaudeTmp(path.join(dir, "none"), { keep: nobody, uid: UID }), { removed: [], failed: [] });
    assert.deepEqual(await removeSessionTmp(path.join(dir, "none"), A, UID), []);
  } finally {
    await done();
  }
});
