// The sidebar: its items' badges, the worktrees' rows and what pressing one opens, their order (dragged, moved with
// the keyboard, held while the pointer is over them), the narrowing to repositories, the worktrees this browser keeps,
// and on a computer its width and folding, on a phone its drawer. With fake gasho-daemons.
import fsp from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { catalogAnswer, checkoutVersion, npmLatestAnswer } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { drag, frames, pointOn, REPO, sendHook, startDrag, worktreeSession } from "./home-sidebar.ts";

test.describe.configure({ mode: "parallel" });

/** The sidebar's list: on a phone, in the drawer, which is opened for it (once one closing is gone). */
async function sidebar(page: Page, isMobile: boolean): Promise<Locator> {
  if (isMobile) {
    const drawer = page.getByRole("dialog", { name: "サイドバー" });
    await expect(drawer).toHaveCount(0);
    await page.getByRole("button", { name: "サイドバーを開く" }).click();
    await expect(drawer).toBeVisible();
  }
  return page.getByRole("navigation", { name: "メニュー" });
}

/** The worktrees' rows, which are the items of the list that can be put in another order. */
const rows = (nav: Locator) => nav.locator("[data-sort-row]");
/** The worktrees' names, in the order of their rows: the first line of a row's button (its repository is under it). */
const rowLabels = (nav: Locator) => rows(nav).evaluateAll((els) => els.map((e) => (e.querySelector("button")?.innerText ?? "").trim().split("\n")[0]));
/** A worktree's row, by its name (the branch). */
const row = (nav: Locator, label: string) => rows(nav).filter({ has: nav.page().getByText(label, { exact: true }) });
/** An item of the sidebar above the worktrees ("ホーム", "端末", "プラグイン"). */
const item = (nav: Locator, label: string) => nav.getByRole("button", { name: new RegExp(`^${label}`) });

/** The sessions of three worktrees, used last in their order (feat/a last of all). */
function threeWorktrees() {
  const now = Date.now();
  return ["feat/a", "feat/b", "feat/c"].map((branch, i) => worktreeSession(`s-${branch.slice(5)}`, { branch, lastActivityAt: now - (i + 1) * 60_000 }));
}

test.describe("項目の札", () => {
  const plugin = { id: "e2e-theme", name: "E2E テーマ", api: "1.12" };
  // A newer gasho-daemon than any of the fakes, and a newer version of the plugin.
  test.use({
    hubOptions: {
      npm: [npmLatestAnswer("@4rtofl/gasho-daemon", "99.0.0"), npmLatestAnswer("@4rtofl/gasho-hub", checkoutVersion("hub"))],
      gh: [
        catalogAnswer({
          plugins: [{ ...plugin, version: "1.1.0", daemon: false, release: `${plugin.id}-v1.1.0`, file: `${plugin.id}-1.1.0.tgz`, sha256: "0".repeat(64), size: 100 }],
        }),
      ],
    },
  });

  test("ホームに未読の通知の数、端末に「更新」、プラグインに更新できる数が出る", async ({ page, hub, isMobile }) => {
    await page.goto("/");
    let nav = await sidebar(page, isMobile);
    for (const label of ["ホーム", "端末", "プラグイン"]) await expect(item(nav, label)).toHaveText(label);

    const sessions = [worktreeSession("alpha"), worktreeSession("bravo")];
    const daemon = await hub.fakeDaemon({ sessions, capabilities: { update: { canUpdate: true } } });
    for (const s of sessions) sendHook(daemon, s.sessionId, "Stop", { summary: "答え" });
    await expect(item(nav, "ホーム")).toHaveText("ホーム2");
    await expect(item(nav, "端末")).toHaveText("端末更新");
    // Installed (not linked, which is a plugin being developed): the Gasho server finds it in its folder.
    const dir = path.join(hub.root, "hub", "plugins", plugin.id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "gasho-plugin.json"), JSON.stringify({ ...plugin, version: "1.0.0", theme: { background: "#0b0b0c" } }));
    await expect(item(nav, "プラグイン")).toHaveText("プラグイン1");

    // Read on the home screen: one less.
    if (isMobile) await page.keyboard.press("Escape");
    await page.getByRole("main").getByRole("button", { name: "既読にする" }).first().click();
    nav = await sidebar(page, isMobile);
    await expect(item(nav, "ホーム")).toHaveText("ホーム1");
  });
});

test.describe("worktree の行", () => {
  test("状態の点、未読のベル、リポジトリ名、working server が複数のときのマシン名、「確認」「オフライン」の札が出る", async ({ page, hub, isMobile }) => {
    const busy = worktreeSession("s-busy", { branch: "feat/busy", status: "busy" });
    const waiting = worktreeSession("s-waiting", { branch: "feat/waiting", status: "waiting" });
    const idle = worktreeSession("s-idle", { branch: "feat/idle", status: "idle" });
    const daemon = await hub.fakeDaemon({ name: "mac", sessions: [busy, waiting, idle] });
    await page.goto("/");
    const nav = await sidebar(page, isMobile);
    // The dot is all that has a colour in a row (the badges are gray): its colour tells the state.
    await expect(row(nav, "feat/busy").locator(".bg-amber-500").last()).toBeVisible();
    await expect(row(nav, "feat/waiting").locator(".bg-amber-500").last()).toBeVisible();
    await expect(row(nav, "feat/idle").locator(".bg-emerald-500")).toBeVisible();
    await expect(row(nav, "feat/waiting")).toContainText("確認");
    await expect(row(nav, "feat/busy")).not.toContainText("確認");
    // With one working server, only the repository.
    for (const label of ["feat/busy", "feat/waiting", "feat/idle"]) await expect(row(nav, label).getByText("gasho", { exact: true })).toBeVisible();

    sendHook(daemon, idle.sessionId, "Stop", { summary: "答え" });
    await expect(row(nav, "feat/idle").getByRole("img", { name: "読んでいない通知があります" })).toBeVisible();
    await expect(row(nav, "feat/busy").getByRole("img", { name: "読んでいない通知があります" })).toHaveCount(0);

    const ubuntu = await hub.fakeDaemon({ name: "ubuntu", sessions: [worktreeSession("s-far", { branch: "feat/far" })] });
    await expect(row(nav, "feat/far").getByText("gasho · ubuntu", { exact: true })).toBeVisible();
    await expect(row(nav, "feat/busy").getByText("gasho · mac", { exact: true })).toBeVisible();
    await ubuntu.disconnect();
    await expect(row(nav, "feat/far")).toContainText("オフライン");
    await expect(row(nav, "feat/far").locator(".bg-neutral-700")).toBeVisible();
  });

  test("行を押すと、最後に開いたセッション、無ければ最後に使ったセッション、無ければ worktree の画面が開く", async ({ page, hub, isMobile }) => {
    const now = Date.now();
    const older = worktreeSession("a-older", { branch: "feat/a", lastActivityAt: now - 10 * 60_000 });
    const newer = worktreeSession("a-newer", { branch: "feat/a", lastActivityAt: now - 60_000 });
    const aPath = older.worktree!.path;
    const bPath = `${REPO}-feat-b`;
    await hub.fakeDaemon({
      sessions: [older, newer],
      // A registered repository: its worktrees show also without sessions.
      repos: [{ path: REPO, worktrees: [{ path: REPO, branch: "main" }, { path: aPath, branch: "feat/a" }, { path: bPath, branch: "feat/b" }] }],
    });
    await page.goto("/");
    await row(await sidebar(page, isMobile), "feat/a").getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: "a-newer", exact: true })).toBeVisible();

    // Opened from home, without leaving the page: the row opens it from now on.
    await item(await sidebar(page, isMobile), "ホーム").click();
    await page.getByRole("main").getByRole("button", { name: /\ba-older\b/ }).click();
    await expect(page.getByRole("heading", { name: "a-older", exact: true })).toBeVisible();
    await item(await sidebar(page, isMobile), "ホーム").click();
    await row(await sidebar(page, isMobile), "feat/a").getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: "a-older", exact: true })).toBeVisible();

    await row(await sidebar(page, isMobile), "feat/b").getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: "feat/b", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("登録したリポジトリ（gasho）の worktree なので");
  });
});

test.describe("並べ替え", () => {
  test("ドラッグ（PC はマウス、スマホはつまみ）と Alt+↑/↓ で並びが変わり、Esc で戻り、読み込み直しても残り、「最後に使った順に戻す」で戻る", async ({ page, hub, isMobile }) => {
    await hub.fakeDaemon({ sessions: threeWorktrees() });
    await page.goto("/");
    let nav = await sidebar(page, isMobile);
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/a", "feat/b", "feat/c"]);
    // On a phone, the handle at the row's right; on a computer, the row itself.
    const grip = (label: string) => (isMobile ? row(nav, label).locator("[data-sort-handle]") : row(nav, label).getByRole("button").first());
    const home = page.getByRole("main").getByRole("heading", { name: "ホーム" });
    const above = async (label: string) => pointOn(row(nav, label), 0, -((await row(nav, label).boundingBox())!.height / 2) + 2);

    // Esc while dragging: back where it was, and nothing opens.
    let d = await startDrag(page, isMobile, grip("feat/c"));
    await d.to(await above("feat/a"));
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/c", "feat/a", "feat/b"]);
    await page.keyboard.press("Escape");
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/a", "feat/b", "feat/c"]);
    await d.drop();
    await expect(home).toBeVisible();
    if (isMobile) await expect(page.getByRole("dialog", { name: "サイドバー" })).toBeVisible();

    d = await startDrag(page, isMobile, grip("feat/c"));
    await d.to(await above("feat/a"));
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/c", "feat/a", "feat/b"]);
    await d.drop();
    await frames(page);
    expect(await rowLabels(nav)).toEqual(["feat/c", "feat/a", "feat/b"]);
    // A drop opens nothing.
    await expect(home).toBeVisible();
    if (isMobile) await expect(page.getByRole("dialog", { name: "サイドバー" })).toBeVisible();

    await row(nav, "feat/b").getByRole("button").first().focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/c", "feat/b", "feat/a"]);
    await expect(nav.locator("p[aria-live]")).toHaveText("「feat/b」を 2 番目に移動しました（全 3 件）");
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/c", "feat/a", "feat/b"]);

    await page.reload();
    nav = await sidebar(page, isMobile);
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/c", "feat/a", "feat/b"]);
    await nav.getByRole("button", { name: "最後に使った順に戻す" }).click();
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/a", "feat/b", "feat/c"]);
    await expect(nav.getByRole("button", { name: "最後に使った順に戻す" })).toHaveCount(0);
  });

  test("ポインターが一覧の上にあるあいだ（スマホはドロワーが開いているあいだ）は、状態が変わっても並びが変わらない（#109）", async ({ page, hub, isMobile }) => {
    const sessions = threeWorktrees();
    const daemon = await hub.fakeDaemon({ sessions });
    await page.goto("/");
    const nav = await sidebar(page, isMobile);
    await expect.poll(() => rowLabels(nav)).toEqual(["feat/a", "feat/b", "feat/c"]);
    if (!isMobile) await row(nav, "feat/b").hover();

    // feat/c is used now, and works: its dot tells that the change has come.
    daemon.updateSession(sessions[2]!.sessionId, { status: "busy", lastActivityAt: Date.now() });
    await expect(row(nav, "feat/c").locator(".bg-amber-500").last()).toBeVisible();
    await frames(page);
    expect(await rowLabels(nav)).toEqual(["feat/a", "feat/b", "feat/c"]);

    if (isMobile) await page.keyboard.press("Escape");
    else await page.mouse.move(800, 400);
    const after = await sidebar(page, isMobile);
    await expect.poll(() => rowLabels(after)).toEqual(["feat/c", "feat/a", "feat/b"]);
  });
});

test.describe("絞り込み", () => {
  /** Closes the menu: Esc on a computer; on a phone, a tap on the drawer beside it (Esc is tried on its own below). */
  async function closeMenu(page: Page, isMobile: boolean) {
    if (isMobile) {
      const box = (await page.getByRole("dialog", { name: "サイドバー" }).boundingBox())!;
      await page.touchscreen.tap(box.x + 20, box.y + box.height - 20);
    } else await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }

  test("リポジトリを選ぶと、その worktree だけが出て、見出しが「worktree · 名前」になり、読み込み直しても残る", async ({ page, hub, isMobile }) => {
    await hub.fakeDaemon({
      sessions: [worktreeSession("g1", { branch: "feat/g1" }), worktreeSession("g2", { branch: "feat/g2" }), worktreeSession("n1", { branch: "feat/n1", repo: "/work/notes" })],
    });
    await page.goto("/");
    let nav = await sidebar(page, isMobile);
    await expect(nav.getByText("worktree", { exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "リポジトリで絞り込む" }).click();
    await page.getByRole("menuitemcheckbox", { name: "notes" }).click();
    await page.getByRole("menuitemcheckbox", { name: "gasho" }).click();
    await closeMenu(page, isMobile);
    await expect(nav.getByText("worktree · gasho、notes", { exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "リポジトリで絞り込む（gasho、notes）" }).click();
    await page.getByRole("menuitemcheckbox", { name: "notes" }).click();
    await closeMenu(page, isMobile);
    await expect(nav.getByText("worktree · gasho", { exact: true })).toBeVisible();
    await expect.poll(() => rowLabels(nav)).toEqual(expect.arrayContaining(["feat/g1", "feat/g2"]));
    expect(await rowLabels(nav)).toHaveLength(2);

    await page.reload();
    nav = await sidebar(page, isMobile);
    await expect(nav.getByText("worktree · gasho", { exact: true })).toBeVisible();
    expect(await rowLabels(nav)).toHaveLength(2);
    await nav.getByRole("button", { name: "リポジトリで絞り込む（gasho）" }).click();
    await page.getByRole("menuitemcheckbox", { name: "すべて" }).click();
    await closeMenu(page, isMobile);
    await expect(nav.getByText("worktree", { exact: true })).toBeVisible();
    await expect.poll(async () => (await rowLabels(nav)).length).toBe(3);
  });

  test("ドロワーの中で絞り込みのメニューを Esc で閉じても、ドロワーは開いたまま", async ({ page, hub, isMobile }) => {
    test.skip(!isMobile, "ドロワーはスマホの幅のもの");
    test.fail(true, "Esc でメニューを閉じると、ドロワーも一緒に閉じる（ドロワーの Esc の処理が、メニューを閉じた Esc も受ける。#183）");
    await hub.fakeDaemon({ sessions: [worktreeSession("g1", { branch: "feat/g1" })] });
    await page.goto("/");
    const nav = await sidebar(page, isMobile);
    const filter = nav.getByRole("button", { name: "リポジトリで絞り込む" });
    await filter.click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Closing, the drawer would slide away with the button in it.
    await filter.click({ timeout: 10_000 });
    await expect(page.getByRole("menu")).toBeVisible();
  });
});

test.describe("ブラウザーが覚えている worktree", () => {
  test("セッションが無くなっても行が残り、worktree の画面の「サイドバーから外す」で消える", async ({ page, hub, isMobile }) => {
    const s = worktreeSession("old", { branch: "feat/old" });
    const daemon = await hub.fakeDaemon({ sessions: [s] });
    await page.goto("/");
    let nav = await sidebar(page, isMobile);
    await expect(row(nav, "feat/old")).toBeVisible();
    daemon.setSessions([]);
    await expect(page.getByRole("main").getByText("1 台の working server・0 セッション")).toBeVisible();
    await expect(row(nav, "feat/old").locator(".bg-neutral-500")).toBeVisible();

    await page.reload();
    nav = await sidebar(page, isMobile);
    await row(nav, "feat/old").getByRole("button").first().click();
    await expect(page.getByRole("heading", { name: "feat/old", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "サイドバーから外す" }).click();
    await expect(page.getByRole("main").getByRole("heading", { name: "ホーム" })).toBeVisible();
    nav = await sidebar(page, isMobile);
    await expect(row(nav, "feat/old")).toHaveCount(0);
    await page.reload();
    nav = await sidebar(page, isMobile);
    await expect(item(nav, "ホーム")).toBeVisible();
    await expect(row(nav, "feat/old")).toHaveCount(0);
  });
});

test.describe("幅（PC）", () => {
  test("端のドラッグで 200〜360px、←/→ で 8px ずつ変わり、ダブルクリックで標準に戻り、読み込み直しても残る", async ({ page, isMobile }) => {
    test.skip(isMobile, "幅を変えられるのは PC の幅のサイドバーだけ");
    await page.goto("/");
    const edge = page.getByRole("separator", { name: "サイドバーの幅" });
    const aside = edge.locator("xpath=..");
    const width = async () => Math.round((await aside.boundingBox())!.width);
    await expect(edge).toHaveAttribute("aria-valuenow", "248");

    await drag(page, false, edge, await pointOn(edge, 300, 0));
    await expect(edge).toHaveAttribute("aria-valuenow", "360");
    await expect.poll(width).toBe(360);
    await drag(page, false, edge, await pointOn(edge, -400, 0));
    await expect(edge).toHaveAttribute("aria-valuenow", "200");
    await expect.poll(width).toBe(200);

    await edge.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(edge).toHaveAttribute("aria-valuenow", "216");
    await page.keyboard.press("ArrowLeft");
    await expect(edge).toHaveAttribute("aria-valuenow", "208");
    await page.reload();
    await expect(edge).toHaveAttribute("aria-valuenow", "208");
    await expect.poll(width).toBe(208);

    await edge.dblclick();
    await expect(edge).toHaveAttribute("aria-valuenow", "248");
    await expect.poll(width).toBe(248);
  });

  test("窓を狭くすると縮み、別のタブで変えた幅を追いかける", async ({ page, context, isMobile }) => {
    test.skip(isMobile, "幅を変えられるのは PC の幅のサイドバーだけ");
    await page.goto("/");
    const edge = page.getByRole("separator", { name: "サイドバーの幅" });
    await drag(page, false, edge, await pointOn(edge, 300, 0));
    await expect(edge).toHaveAttribute("aria-valuenow", "360");
    // The narrowest panel of a session and its conversation keep their room beside it.
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(edge).toHaveAttribute("aria-valuenow", "280");
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(edge).toHaveAttribute("aria-valuenow", "360");

    const other = await context.newPage();
    await other.goto("/");
    const otherEdge = other.getByRole("separator", { name: "サイドバーの幅" });
    await expect(otherEdge).toHaveAttribute("aria-valuenow", "360");
    await edge.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(otherEdge).toHaveAttribute("aria-valuenow", "352");
  });
});

test.describe("畳む・開く", () => {
  test("PC の幅では ⌘B・Ctrl+B と「畳む」ボタンで畳んで開き、畳むとアイコンとツールチップになる", async ({ page, isMobile }) => {
    test.skip(isMobile, "畳めるのは PC の幅のサイドバーだけ（スマホはドロワーの試験で試す）");
    await page.goto("/");
    const toggle = (name: string) => page.getByRole("button", { name });
    const aside = page.getByRole("navigation", { name: "メニュー" }).locator("xpath=../..");
    const tip = page.getByRole("tooltip");
    await expect(toggle("サイドバーを畳む")).toContainText("⌘B");

    await page.keyboard.press("Meta+b");
    await expect(toggle("サイドバーを開く")).toBeVisible();
    await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(56);
    await expect(page.getByText("Gasho", { exact: true })).toHaveCount(0);
    // Named by their tooltips.
    await page.getByRole("button", { name: "ホーム", exact: true }).hover();
    await expect(tip).toHaveText("ホーム");
    await toggle("サイドバーを開く").hover();
    await expect(tip).toHaveText("開く");

    await page.keyboard.press("Control+b");
    await expect(toggle("サイドバーを畳む")).toBeVisible();
    await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBe(248);
    await toggle("サイドバーを畳む").click();
    await expect(toggle("サイドバーを開く")).toBeVisible();
    await toggle("サイドバーを開く").click();
    await expect(toggle("サイドバーを畳む")).toBeVisible();
  });
});

test.describe("ドロワー（スマホ）", () => {
  test("「サイドバーを開く」と ⌘B・Ctrl+B で開き、Esc・背景のタップ・左へのスワイプ・項目で閉じる。開いているあいだ本文はスクロールしない", async ({ page, isMobile }) => {
    test.skip(!isMobile, "ドロワーはスマホの幅のもの");
    await page.goto("/");
    const drawer = page.getByRole("dialog", { name: "サイドバー" });
    const open = () => page.getByRole("button", { name: "サイドバーを開く" }).click();
    const overflow = () => page.evaluate<string>("document.body.style.overflow");

    await open();
    await expect(drawer).toBeVisible();
    expect(await overflow()).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    expect(await overflow()).toBe("");

    await page.keyboard.press("Meta+b");
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Control+b");
    await expect(drawer).toHaveCount(0);

    await open();
    const viewport = page.viewportSize()!;
    await page.touchscreen.tap(viewport.width - 10, viewport.height / 2);
    await expect(drawer).toHaveCount(0);

    await open();
    await expect(drawer).toBeVisible();
    // From the logo, leftwards.
    const logo = drawer.getByText("Gasho", { exact: true });
    await drag(page, true, logo, await pointOn(logo, -200, 0));
    await expect(drawer).toHaveCount(0);

    await open();
    await drawer.getByRole("button", { name: /^設定/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/#\/settings$/);
  });
});
