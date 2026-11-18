import assert from "node:assert/strict";
import { test } from "node:test";
import type { GashoNotification, MachineInfo, SessionInfo } from "@gasho/protocol";
import {
  movedSession,
  narrowWorktrees,
  rememberedOf,
  repoChoices,
  repoKeyOf,
  sessionDot,
  tabAfterRemoval,
  unreadOfSession,
  unreadSessions,
  worktreeDot,
  worktreeLastUsed,
  worktreesByLastUse,
  worktreeStatus,
} from "../src/lib/sessions.ts";

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/repo",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});
const machine = (id: string, sessions: SessionInfo[]): MachineInfo => ({ id, name: id, connected: true, lastSeen: 0, sessions });

test("sessions are grouped by machine and worktree, the worktree used last first, and its tabs in the order they started", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const feat = { path: "/src/app-x", repo: "/src/app", branch: "feat/x" };
  const list = worktreesByLastUse([
    machine("mac", [
      session("a", { cwd: "/src/app/web", worktree: app, startedAt: 20, lastActivityAt: 300 }),
      session("b", { cwd: "/src/app", worktree: app, startedAt: 10, lastActivityAt: 100 }),
      session("c", { cwd: "/src/app-x", worktree: feat, startedAt: 30, lastActivityAt: 400 }),
    ]),
    // The same folder on another working server is another worktree.
    machine("ubuntu", [session("d", { cwd: "/src/app", worktree: app, startedAt: 40, lastActivityAt: 200 })]),
  ]);
  assert.deepEqual(
    list.map((w) => `${w.machine.id} ${w.label}: ${w.sessions.map((s) => s.sessionId).join(",")}`),
    ["mac feat/x: c", "mac main: b,a", "ubuntu main: d"],
  );
});

test("a worktree is named by its branch, else its folder, and its repository by GitHub, else the repository's folder", () => {
  const github = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };
  const list = worktreesByLastUse([
    machine("mac", [
      session("gh", { cwd: "/w/gasho", worktree: { path: "/w/gasho", repo: "/w/gasho", branch: "main" }, github, lastActivityAt: 5 }),
      session("detached", { cwd: "/w/lib-old", worktree: { path: "/w/lib-old", repo: "/w/lib.git" }, lastActivityAt: 4 }),
      // A folder that is not in a repository, or a gasho-daemon too old to tell the worktree: the session's folder.
      session("plain", { cwd: "/w/notes", lastActivityAt: 3 }),
      session("rc", { cwd: "/w/other", lastActivityAt: 9, managed: undefined }),
    ]),
  ]);
  assert.deepEqual(
    list.map((w) => [w.label, w.repo]),
    [
      ["main", "Gasho"],
      ["lib-old", "lib"],
      ["notes", undefined],
    ],
  );
  // What plugins get of a worktree (docs/plugins.md, P15), also once its sessions are gone and the sidebar keeps it.
  const [gasho, , notes] = list;
  assert.ok(gasho && notes);
  assert.deepEqual([gasho.branch, gasho.repoFolder, gasho.github], ["main", "/w/gasho", github]);
  assert.deepEqual([notes.branch, notes.repoFolder, notes.github], [undefined, undefined, undefined]);
  const [kept] = worktreesByLastUse([machine("mac", [])], [rememberedOf(gasho)]);
  assert.deepEqual([kept?.branch, kept?.repoFolder, kept?.github], ["main", "/w/gasho", github]);
});

test("remembered worktrees without sessions come last, once each; the tab after a removed one is the next, else the one before", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const mac = machine("mac", [session("a", { cwd: "/src/app", worktree: app, startedAt: 1 }), session("b", { cwd: "/src/app", worktree: app, startedAt: 2 })]);
  const [live] = worktreesByLastUse([mac]);
  assert.ok(live);
  const gone = { machine: "mac", path: "/src/app-old", label: "feat/old", repo: "app", subfolders: true };
  const list = worktreesByLastUse([mac], [gone, rememberedOf(live), { ...gone, machine: "unregistered" }]);
  assert.deepEqual(
    list.map((w) => `${w.label} ${w.path} ${w.sessions.length}`),
    ["main /src/app 2", "feat/old /src/app-old 0"],
  );

  assert.equal(tabAfterRemoval(live, "a")?.sessionId, "b");
  assert.equal(tabAfterRemoval(live, "b")?.sessionId, "a");
  const [one] = worktreesByLastUse([machine("mac", [session("a")])]);
  assert.ok(one);
  assert.equal(tabAfterRemoval(one, "a"), undefined);
});

test("the sessions open outside Gasho go with the worktree they are in, make no row of their own, and need a process", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const feat = { path: "/src/app-x", repo: "/src/app", branch: "feat/x" };
  const outside = (id: string, extra: Partial<SessionInfo>) => session(id, { managed: undefined, pid: 100, ...extra });
  const mac: MachineInfo = {
    ...machine("mac", [
      session("a", { cwd: "/src/app", worktree: app, lastActivityAt: 1 }),
      outside("o2", { cwd: "/src/app/web", worktree: app, startedAt: 20 }),
      outside("o1", { cwd: "/src/app", worktree: app, startedAt: 10 }),
      // Claude Code runs it in the background, with no process to end.
      outside("bg", { cwd: "/src/app", worktree: app, pid: undefined, kind: "background" }),
      outside("x", { cwd: "/src/app-x", worktree: feat }),
      // In a folder the sidebar has no row for.
      outside("elsewhere", { cwd: "/tmp/scratch" }),
    ]),
    repos: [{ path: "/src/app", worktrees: [{ path: "/src/app", branch: "main" }, { path: "/src/app-x", branch: "feat/x" }] }],
  };
  const list = worktreesByLastUse([mac]);
  assert.deepEqual(
    list.map((w) => `${w.label}: ${w.sessions.map((s) => s.sessionId).join(",")} / ${w.outside.map((s) => s.sessionId).join(",")}`),
    ["main: a / o1,o2", "feat/x:  / x"],
  );
});

test("a registered repository's other worktrees follow those with sessions, and git's list decides which remembered ones stay", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const mac: MachineInfo = {
    ...machine("mac", [session("a", { cwd: "/src/app", worktree: app, lastActivityAt: 1 }), session("n", { cwd: "/notes", lastActivityAt: 2 })]),
    repos: [
      {
        path: "/src/app",
        github: { owner: "o", name: "app", url: "https://github.com/o/app" },
        worktrees: [
          // Switched since the session's worktree was read.
          { path: "/src/app", branch: "feat/y" },
          { path: "/src/app-x", branch: "feat/x" },
          { path: "/src/app-detached" },
        ],
      },
    ],
  };
  const remembered = [
    // Removed with git since: the repository's list no longer has it.
    { machine: "mac", path: "/src/app-old", label: "feat/old", repo: "app", repoFolder: "/src/app", subfolders: true },
    { machine: "mac", path: "/lib", label: "main", repo: "lib", repoFolder: "/lib", subfolders: true },
  ];
  const list = worktreesByLastUse([mac], remembered);
  assert.deepEqual(
    list.map((w) => `${w.label} ${w.sessions.length}${w.registered ? " registered" : ""}`),
    ["notes 1", "feat/y 1 registered", "feat/x 0 registered", "app-detached 0 registered", "main 0"],
  );
  // What plugins get of them (docs/plugins.md, P15) comes from git's list too.
  assert.deepEqual(
    list.slice(1, 4).map((w) => [w.branch, w.repoFolder, w.github?.name]),
    [
      ["feat/y", "/src/app", undefined],
      ["feat/x", "/src/app", "app"],
      [undefined, "/src/app", "app"],
    ],
  );
  assert.deepEqual(
    repoChoices(list).map((r) => [r.key, r.name]),
    [
      [repoKeyOf(list[1]!), "app"],
      [repoKeyOf(list[4]!), "lib"],
    ],
  );
});

test("a worktree's state is its most pressing session's, unknown offline or without sessions; its last use, its session used last", () => {
  const w = (statuses: SessionInfo["status"][], connected = true) => ({
    machine: { ...machine("mac", []), connected },
    sessions: statuses.map((status, i) => session(`s${i}`, { status, startedAt: i, lastActivityAt: 100 + i })),
  });
  assert.equal(worktreeStatus(w(["idle", "busy"])), "busy");
  assert.equal(worktreeStatus(w(["busy", "waiting", "idle"])), "waiting");
  assert.equal(worktreeStatus(w(["idle"])), "idle");
  assert.equal(worktreeStatus(w(["unknown"])), "unknown");
  assert.equal(worktreeStatus(w([])), "unknown");
  assert.equal(worktreeStatus(w(["waiting"], false)), "unknown");
  assert.equal(worktreeLastUsed(w(["idle", "busy", "idle"])), 102);
  assert.equal(worktreeLastUsed(w([])), undefined);
});

test("the worktrees narrowed to the repositories picked keep their order; none picked keeps them all", () => {
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const machines = [
    machine("mac", [
      session("a", { worktree: app, lastActivityAt: 300 }),
      session("b", { cwd: "/src/lib", worktree: { path: "/src/lib", repo: "/src/lib", branch: "main" }, lastActivityAt: 200 }),
      // Outside a repository: never in a repository picked.
      session("c", { cwd: "/tmp/notes", lastActivityAt: 100 }),
    ]),
  ];
  const all = worktreesByLastUse(machines);
  const choices = repoChoices(all);
  assert.deepEqual(narrowWorktrees(all, []).map((w) => w.path), ["/src/app", "/src/lib", "/tmp/notes"]);
  assert.deepEqual(narrowWorktrees(all, choices.filter((r) => r.name === "lib")).map((w) => w.path), ["/src/lib"]);
  assert.deepEqual(narrowWorktrees([...all].reverse(), choices).map((w) => w.path), ["/src/lib", "/src/app"]);
});

test("a worktree's dot is its most pressing session's, gray without sessions, and a bell while a session of it has an unread notification", () => {
  const note = (machine: string, sessionId: string, read: boolean): GashoNotification => ({
    id: `${machine}-${sessionId}-${read}`,
    machine,
    sessionId,
    at: 0,
    kind: "done",
    title: "",
    read,
  });
  const app = { path: "/src/app", repo: "/src/app", branch: "main" };
  const lib = { path: "/src/lib", repo: "/src/lib", branch: "main" };
  const mac = machine("mac", [
    session("a", { cwd: "/src/app", worktree: app, status: "idle" }),
    session("b", { cwd: "/src/app", worktree: app, status: "busy" }),
    session("c", { cwd: "/src/lib", worktree: lib, status: "idle" }),
  ]);
  const gone = { machine: "mac", path: "/src/old", label: "feat/old", subfolders: true };
  const dots = (notes: GashoNotification[], machines = [mac]) => {
    const unread = unreadSessions(notes);
    return worktreesByLastUse(machines, [gone]).map((w) => `${w.label} ${w.path}: ${worktreeDot(w, unread).status} ${worktreeDot(w, unread).unread}`);
  };

  // A notification read, or one of a session of the same id on another working server, rings no bell.
  assert.deepEqual(dots([note("mac", "a", true), note("ubuntu", "c", false)]), [
    "main /src/app: busy false",
    "main /src/lib: idle false",
    "feat/old /src/old: none false",
  ]);
  assert.deepEqual(dots([note("mac", "a", false)]), [
    "main /src/app: busy true",
    "main /src/lib: idle false",
    "feat/old /src/old: none false",
  ]);
  // Offline, the state cannot be told, but what was not read stays so.
  const offline = { ...mac, connected: false };
  assert.deepEqual(dots([note("mac", "c", false)], [offline]), [
    "main /src/app: unknown false",
    "main /src/lib: unknown true",
    "feat/old /src/old: unknown false",
  ]);
  assert.deepEqual(sessionDot(offline, offline.sessions[2]!, unreadSessions([note("mac", "c", false)])), { status: "unknown", unread: true });
  // After /clear, what came under the id from before rings the bell of the session it went on as.
  const cleared = machine("mac", [session("a2", { cwd: "/src/app", worktree: app, previousSessionIds: ["a"] })]);
  assert.equal(dots([note("mac", "a", false)], [cleared])[0], "main /src/app: idle true");
});

test("a page open on an id from before /clear goes to the session that had it; one on a listed or unknown id stays", () => {
  const mac = machine("mac", [session("b", { previousSessionIds: ["a", "c"] }), session("c")]);
  assert.equal(movedSession(mac, "a")?.sessionId, "b");
  // "c" runs again as a session of its own (an earlier conversation opened again): its page stays.
  assert.equal(movedSession(mac, "c"), undefined);
  assert.equal(movedSession(mac, "x"), undefined);
  assert.equal(movedSession(undefined, "a"), undefined);
});

test("an open session reads its unread notifications, those under an id it had before /clear too", () => {
  const note = (id: string, machine: string, sessionId: string, read = false): GashoNotification => ({ id, machine, sessionId, at: 0, kind: "done", title: "", read });
  const machines = [machine("mac", [session("b", { previousSessionIds: ["a"] }), session("c")])];
  const notes = [note("1", "mac", "a"), note("2", "mac", "b"), note("3", "mac", "b", true), note("4", "mac", "c"), note("5", "ubuntu", "a")];
  assert.deepEqual(unreadOfSession(notes, machines, "mac", "b").map((n) => n.id), ["1", "2"]);
  // Open on an id no session lists (the page has not gone on to the new id yet): those under that id.
  assert.deepEqual(unreadOfSession(notes, machines, "mac", "a").map((n) => n.id), ["1"]);
});

test("a hibernated session has a dot of its own, and a worktree has it only when all of its sessions are hibernated", () => {
  const worktree = { path: "/repo", repo: "/repo", branch: "main" };
  const asleep = session("s1", { hibernation: "hibernated", worktree });
  const back = session("s2", { hibernation: "resuming", worktree });
  const awake = session("s3", { worktree });
  const m = machine("m1", [asleep, back, awake]);
  assert.equal(sessionDot(m, asleep, new Set()).status, "hibernated");
  assert.equal(sessionDot(m, back, new Set()).status, "busy");
  assert.equal(sessionDot({ ...m, connected: false }, asleep, new Set()).status, "unknown");
  assert.equal(worktreeDot({ machine: m, sessions: [asleep] } as never, new Set()).status, "hibernated");
  assert.equal(worktreeDot({ machine: m, sessions: [asleep, awake] } as never, new Set()).status, "idle");
});
