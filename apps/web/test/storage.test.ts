// What this browser keeps in localStorage beside the hooks that read it: the worktrees kept in the sidebar
// (lib/remembered-worktrees), the grouping of the worktrees picked and the plugin list shown last (lib/session-list-prefs).
// Each module reads the storage once, so each case loads it afresh over a storage of its own. npm run test:coverage
// counts only one of these loads of a file, so it shows the two modules less covered than they are.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RememberedWorktree } from "../src/lib/sessions.ts";

/** A localStorage that keeps what is written (`blocked`: every call throws, as in a private window). */
function storage(initial: Record<string, string> = {}, blocked = false) {
  const items = new Map(Object.entries(initial));
  const writes: [string, string | null][] = [];
  const fake = {
    getItem: (k: string) => {
      if (blocked) throw new Error("SecurityError");
      return items.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      writes.push([k, v]);
      if (blocked) throw new Error("QuotaExceededError");
      items.set(k, v);
    },
    removeItem: (k: string) => {
      writes.push([k, null]);
      if (blocked) throw new Error("SecurityError");
      items.delete(k);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  return { items, writes };
}

let loads = 0;
async function fresh<T>(relative: string): Promise<T> {
  return (await import(`${new URL(relative, import.meta.url).href}?${++loads}`)) as T;
}

type Worktrees = typeof import("../src/lib/remembered-worktrees.ts");
type Prefs = typeof import("../src/lib/session-list-prefs.ts");

const wt = (n: string, more: Partial<RememberedWorktree> = {}): RememberedWorktree => ({ machine: "mac", path: `/src/${n}`, label: n, subfolders: false, ...more });
const saved = (s: { items: Map<string, string> }) => JSON.parse(s.items.get("gasho.worktrees") ?? "null") as RememberedWorktree[] | null;

test("worktrees are kept new ones first; one kept already is updated where it is; none twice; the oldest go past 100", async () => {
  const s = storage();
  const { rememberWorktrees, forgetWorktree } = await fresh<Worktrees>("../src/lib/remembered-worktrees.ts");
  rememberWorktrees([wt("a"), wt("b")]);
  assert.deepEqual(saved(s)?.map((r) => r.label), ["a", "b"]);
  rememberWorktrees([wt("c"), wt("b", { branch: "feat/x" }), wt("c")]);
  assert.deepEqual(saved(s), [wt("c"), wt("a"), wt("b", { branch: "feat/x" })]);
  // Nothing new: nothing written.
  const writes = s.writes.length;
  rememberWorktrees([wt("a"), wt("b", { branch: "feat/x" })]);
  assert.equal(s.writes.length, writes);
  // The same path on another machine is another worktree.
  rememberWorktrees([wt("a", { machine: "ubuntu" })]);
  forgetWorktree("mac", "/src/a");
  assert.deepEqual(saved(s)?.map((r) => `${r.machine}:${r.label}`), ["ubuntu:a", "mac:c", "mac:b"]);

  rememberWorktrees(Array.from({ length: 105 }, (_, i) => wt(`n${i}`)));
  const kept = saved(s) ?? [];
  assert.equal(kept.length, 100);
  assert.equal(kept[0]?.label, "n0");
  assert.equal(kept.at(-1)?.label, "n99");
});

test("kept worktrees of a wrong shape are left out, and storage that cannot be read starts with none", async () => {
  const good = wt("good", { repo: "r", branch: "main", github: { owner: "o", name: "n", url: "https://github.com/o/n" } });
  const bad = [
    { ...wt("m"), machine: 1 },
    { ...wt("p"), path: null },
    { ...wt("l"), label: undefined },
    { ...wt("x"), subfolders: "no" },
    { ...wt("r"), repo: 1 },
    { ...wt("z"), branch: 1 },
    { ...wt("f"), repoFolder: false },
    { ...wt("y"), github: { owner: "o" } },
    null,
    "mac:/src/w",
  ];
  const s = storage({ "gasho.worktrees": JSON.stringify([...bad, good]) });
  const read = await fresh<Worktrees>("../src/lib/remembered-worktrees.ts");
  read.forgetWorktree("mac", "/src/none");
  assert.deepEqual(saved(s), [good]);

  for (const text of ["{", JSON.stringify({ worktrees: [good] })]) {
    const broken = storage({ "gasho.worktrees": text });
    (await fresh<Worktrees>("../src/lib/remembered-worktrees.ts")).forgetWorktree("mac", "/src/none");
    assert.deepEqual(saved(broken), []);
  }
});

test("where storage is blocked, the worktrees are kept for this page view", async () => {
  const s = storage({}, true);
  const { rememberWorktrees } = await fresh<Worktrees>("../src/lib/remembered-worktrees.ts");
  rememberWorktrees([wt("a")]);
  rememberWorktrees([wt("b")]);
  const last = s.writes.at(-1)?.[1];
  assert.deepEqual((JSON.parse(last ?? "[]") as RememberedWorktree[]).map((r) => r.label), ["b", "a"]);
});

test("the grouping picked is saved when it changes, not when the one saved (in an earlier page) is picked again", async () => {
  const s = storage({ "gasho.worktreeGrouping": JSON.stringify({ plugin: "p", grouping: "status" }) });
  const { chooseGrouping } = await fresh<Prefs>("../src/lib/session-list-prefs.ts");
  chooseGrouping({ plugin: "p", grouping: "status" });
  assert.equal(s.writes.length, 0);
  chooseGrouping("none");
  assert.equal(s.items.get("gasho.worktreeGrouping"), '"none"');
  chooseGrouping("none");
  assert.equal(s.writes.length, 1);
  chooseGrouping({ plugin: "p", grouping: "repo" });
  assert.equal(s.items.get("gasho.worktreeGrouping"), JSON.stringify({ plugin: "p", grouping: "repo" }));
});

test("the plugin list shown last is saved when it changes, and forgotten when none is shown", async () => {
  const s = storage({ "gasho.sessionList": JSON.stringify({ plugin: "p", hideTabs: true }) });
  const { rememberList } = await fresh<Prefs>("../src/lib/session-list-prefs.ts");
  rememberList({ plugin: "p", hideTabs: true });
  assert.equal(s.writes.length, 0);
  rememberList({ plugin: "p", hideTabs: false });
  assert.equal(s.items.get("gasho.sessionList"), JSON.stringify({ plugin: "p", hideTabs: false }));
  rememberList({ plugin: "q", hideTabs: false });
  assert.equal(s.items.get("gasho.sessionList"), JSON.stringify({ plugin: "q", hideTabs: false }));
  rememberList(undefined);
  assert.equal(s.items.has("gasho.sessionList"), false);
  rememberList(undefined);
  assert.equal(s.writes.length, 3);
});
