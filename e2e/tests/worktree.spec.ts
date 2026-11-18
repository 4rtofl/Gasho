// The screen of a worktree with no session open: it moves to the worktree's session once there is one, tells when the
// worktree is not in the sidebar, and otherwise shows the tabs row, the worktree, and how to start a session there;
// a worktree only this browser keeps can be taken off the sidebar.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { commandResult, type FakeDaemon, fakeSession } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { CATEGORIES_PLUGIN, deferred, expectSessionOpen, openHome, pressInSidebar, sidebar, started } from "./launch-helpers.ts";
import { closeSidebar } from "./screen.ts";

const LAUNCH_HERE = "この worktree で新しいセッションを起動";
const APP = { path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] };

/** Opens a worktree's screen by its URL, as a plugin's link does: a new entry of the browser's history. */
async function openWorktree(page: Page, daemon: FakeDaemon, path: string): Promise<void> {
  await page.evaluate((hash) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = hash;
  }, `#/w/${encodeURIComponent(daemon.machineId)}/${encodeURIComponent(path)}`);
}

/** The home screen is shown: not a session's, not a worktree's. */
async function expectHome(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/#\/[sw]\//);
  await expect(page.getByRole("heading", { name: "ホーム", level: 1 })).toBeVisible();
}

test("セッションのある worktree の画面を開くと、そのセッションへ移り、戻るとその前の画面に戻る", async ({ page, hub }) => {
  const sessionId = randomUUID();
  const daemon = await hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId, cwd: "/work/app/src", name: "e2e-session", worktree: { path: "/work/app", repo: "/work/app", branch: "main" } })],
  });
  await openHome(page, 1);
  await expect(page.getByText("1 台の working server・1 セッション")).toBeVisible();
  await openWorktree(page, daemon, "/work/app");
  await expect(page).toHaveURL(new RegExp(`#/s/${daemon.machineId}/${sessionId}$`));
  // The worktree's screen took no entry of the history: back is the home screen.
  await page.goBack();
  await expectHome(page);
});

test("セッションの無い worktree の画面にいるあいだにセッションが起動すると、そのセッションへ移る", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({ name: "mac", repos: [APP] });
  await openHome(page, 1);
  await pressInSidebar(page, /^main/);
  await expect(page.getByRole("main").getByRole("heading", { name: "main", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#\/w\//);

  // Started elsewhere: in the official app, or by another browser.
  const sessionId = randomUUID();
  daemon.setSessions([fakeSession({ sessionId, cwd: "/work/app", worktree: { path: "/work/app", repo: "/work/app", branch: "main" } })]);
  await expect(page).toHaveURL(new RegExp(`#/s/${daemon.machineId}/${sessionId}$`));
  await page.goBack();
  await expectHome(page);
});

test("サイドバーに無い worktree の画面は、そう出し、ホームへ戻れる", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({ name: "mac", repos: [APP] });
  await openHome(page, 1);
  await openWorktree(page, daemon, "/work/nowhere");
  const main = page.getByRole("main");
  await expect(main.getByText("この worktree はサイドバーにありません。")).toBeVisible();
  await main.getByRole("button", { name: "ホーム" }).click();
  await expectHome(page);
});

test("セッションの無い worktree は、タブの行・名前・パス・説明を出し、「＋」で起動したセッションが開く", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({
    name: "mac",
    repos: [{ path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }, { path: "/work/app-feat", branch: "feat" }] }],
  });
  daemon.handle("session.launch", (msg) => started(daemon, msg));
  await openHome(page, 1);
  await pressInSidebar(page, /^feat/);

  const main = page.getByRole("main");
  const tabs = main.getByRole("navigation", { name: "この worktree のセッション" });
  await expect(tabs.getByRole("button", { name: LAUNCH_HERE })).toBeEnabled();
  await expect(main.getByRole("heading", { name: "feat", level: 1 })).toBeVisible();
  await expect(main.getByText("mac · /work/app-feat")).toBeVisible();
  await expect(main.getByText("この worktree にセッションはありません。タブの右の「＋」で新しいセッションを起動するか、左の履歴から過去の会話を開き直せます。")).toBeVisible();
  await expect(main.getByText("登録したリポジトリ（app）の worktree なので、git の一覧にあるあいだはサイドバーに出ます。")).toBeVisible();
  await expect(main.getByRole("button", { name: "サイドバーから外す" })).toHaveCount(0);

  await tabs.getByRole("button", { name: LAUNCH_HERE }).click();
  await expectSessionOpen(page, daemon, "/work/app-feat");
});

test("「＋」で起動できないとタブの行に理由を出し、起動できない working server では「＋」を押せない", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({ name: "mac", repos: [APP] });
  daemon.handle("session.launch", (msg) => commandResult(msg, { ok: false, error: "端末を作れませんでした。" }));
  await openHome(page, 1);
  await pressInSidebar(page, /^main/);
  const tabs = page.getByRole("navigation", { name: "この worktree のセッション" });
  await tabs.getByRole("button", { name: LAUNCH_HERE }).click();
  await expect(tabs.getByRole("alert")).toHaveText("端末を作れませんでした。");

  daemon.setCapabilities({ canLaunch: false });
  await expect(tabs.getByRole("button", { name: LAUNCH_HERE })).toBeDisabled();
});

test("覚えているだけの worktree は「サイドバーから外す」で消え、読み込み直しても出ない", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId: randomUUID(), cwd: "/work/tmp", worktree: { path: "/work/tmp", repo: "/work/tmp", branch: "spike" } })],
  });
  await openHome(page, 1);
  await expect(page.getByText("1 台の working server・1 セッション")).toBeVisible();
  // Its sessions are gone; this browser keeps the worktree in the sidebar.
  daemon.setSessions([]);
  await expect(page.getByText("1 台の working server・0 セッション")).toBeVisible();
  await pressInSidebar(page, /^spike/);

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "spike", level: 1 })).toBeVisible();
  await expect(main.getByText("mac · /work/tmp")).toBeVisible();
  await expect(main.getByText(/^この worktree にセッションはありません。/)).toBeVisible();
  await expect(main.getByText(/^登録したリポジトリ/)).toHaveCount(0);
  await main.getByRole("button", { name: "サイドバーから外す" }).click();
  await expectHome(page);
  await expect((await sidebar(page)).getByRole("button", { name: /^spike/ })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("1 台の working server・0 セッション")).toBeVisible();
  await expect((await sidebar(page)).getByRole("button", { name: /^spike/ })).toHaveCount(0);
});

test.describe("プラグインがセッションのタブを隠すとき", () => {
  test.use({ hubOptions: { plugins: [CATEGORIES_PLUGIN] } });

  test("本文の「この worktree で新しいセッションを起動」で起動し、起動できないと理由を出す", async ({ page, hub }) => {
    const daemon = await hub.fakeDaemon({ name: "mac", repos: [APP] });
    const answer = deferred();
    let fails = true;
    daemon.handle("session.launch", async (msg) => {
      if (!fails) return started(daemon, msg);
      await answer.promise;
      return commandResult(msg, { ok: false, error: "端末を作れませんでした。" });
    });
    await openHome(page, 1);
    // The categories have taken the place of the worktrees' rows.
    await expect((await sidebar(page)).getByRole("button", { name: "main で新しいセッションを起動" })).toBeVisible();
    await closeSidebar(page);
    await openWorktree(page, daemon, "/work/app");

    const main = page.getByRole("main");
    const row = main.getByRole("navigation", { name: "この worktree" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: LAUNCH_HERE })).toHaveCount(0);
    await expect(main.getByText("この worktree にセッションはありません。新しいセッションを起動するか、上の行の左の履歴から過去の会話を開き直せます。")).toBeVisible();
    const launch = main.getByRole("button", { name: LAUNCH_HERE });
    await launch.click();
    await expect(launch).toBeDisabled();
    answer.resolve();
    await expect(main.getByRole("alert")).toHaveText("端末を作れませんでした。");

    fails = false;
    await launch.click();
    await expectSessionOpen(page, daemon, "/work/app");
  });

  test("起動できない working server では、本文の起動のボタンを押せない", async ({ page, hub }) => {
    const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { canLaunch: false }, repos: [APP] });
    await openHome(page, 1);
    await openWorktree(page, daemon, "/work/app");
    const launch = page.getByRole("main").getByRole("button", { name: LAUNCH_HERE });
    await expect(launch).toBeDisabled();
    await expect(launch).toHaveAttribute("title", "接続していて、セッションの端末を作れる working server でだけ起動できます");
  });
});
