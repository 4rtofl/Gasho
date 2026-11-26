// The row above a session: the tabs of the sessions in its worktree and "＋", each tab's menu (rename, fork, remove),
// the past conversations of the worktree, and, above the row, the conversations open in it outside Gasho.
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { SessionInfo } from "@gasho/protocol";
import { commandResult, type FakeDaemon, type FakeDaemonOptions, fakeSession, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";

const WORKTREE = { path: "/work/gasho", repo: "/work/gasho", branch: "main" };
const HOUR = 3_600_000;
const id = (n: number) => `7a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ONE = id(1);
const TWO = id(2);
const THREE = id(3);

/** A session of the worktree, started `ago` ms before now. */
function tabSession(sessionId: string, name: string, ago: number, o: Partial<SessionInfo> = {}): SessionInfo {
  return fakeSession({ sessionId, cwd: WORKTREE.path, name, worktree: WORKTREE, startedAt: Date.now() - ago, lastActivityAt: Date.now() - ago, ...o });
}

/** Three sessions of one worktree, started one after another, given out of order; `open` is opened. */
async function openTabs(page: Page, hub: GashoHub, o: { open?: string; sessions?: SessionInfo[]; daemon?: FakeDaemonOptions } = {}): Promise<FakeDaemon> {
  const daemon = await hub.fakeDaemon({
    name: "mac",
    ...o.daemon,
    sessions: o.sessions ?? [tabSession(THREE, "三つ目", 1 * HOUR), tabSession(ONE, "一つ目", 3 * HOUR), tabSession(TWO, "二つ目", 2 * HOUR)],
  });
  await page.goto(`/#/s/${daemon.machineId}/${o.open ?? TWO}`);
  await expect(tabsOf(page)).toBeVisible();
  return daemon;
}

const tabsOf = (page: Page) => page.getByRole("navigation", { name: "この worktree のセッション" });
const tab = (page: Page, name: string) => tabsOf(page).getByRole("button", { name, exact: true });
const openTab = (page: Page) => tabsOf(page).locator('[aria-current="page"]');

/** Opens a tab's menu as one would: a right-click on a computer, a long press on a touch screen. */
async function openMenu(page: Page, target: Locator, testInfo: TestInfo): Promise<Locator> {
  const menu = page.getByRole("menu");
  if (testInfo.project.use.hasTouch) await longPress(target, menu);
  else await target.click({ button: "right" });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * A finger held on the element until `menu` opens, then lifted: Playwright has no long press, and Radix's menu opens on
 * a touch held for 700 ms. Only the pointer events are sent, not the click a browser may send once the finger lifts:
 * whether that click opens the session is seen on a real device.
 */
async function longPress(target: Locator, menu: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("the element to press is not shown");
  // Taken before the menu opens, which hides the rest of the page from the accessibility tree (and from getByRole).
  const el = await target.elementHandle();
  const at = { pointerType: "touch", isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await el.dispatchEvent("pointerdown", at);
  await expect(menu).toBeVisible();
  await el.dispatchEvent("pointerup", at);
  await el.dispose();
}

/** Adds a session to the fake daemon's, as gasho-daemon does before it answers that it started one. */
function addsSession(daemon: FakeDaemon, s: SessionInfo): void {
  daemon.setSessions([...daemon.sessions, s]);
}

test("同じ worktree のセッションのタブが起動した順に並び、開いているタブが分かり、「＋」で起動したセッションを開く", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub, {
    sessions: [
      tabSession(THREE, "三つ目", 1 * HOUR),
      tabSession(ONE, "一つ目", 3 * HOUR),
      tabSession(TWO, "二つ目", 2 * HOUR),
      fakeSession({ sessionId: id(9), cwd: "/work/other", name: "別の worktree", worktree: { path: "/work/other", repo: "/work/gasho", branch: "other" } }),
    ],
  });

  await expect(tabsOf(page).getByRole("button").filter({ hasText: /\S/ })).toHaveText(["一つ目", "二つ目", "三つ目"]);
  await expect(openTab(page)).toHaveText("二つ目");
  // Nothing is open in the worktree outside Gasho.
  await expect(page.getByRole("button", { name: "Gasho に移す" })).toHaveCount(0);
  await tab(page, "三つ目").click();
  await expect(openTab(page)).toHaveText("三つ目");

  daemon.handle("session.launch", (m) => commandResult(m, { ok: false, error: "端末を作れませんでした（E2E）" }));
  await page.getByRole("button", { name: "この worktree で新しいセッションを起動" }).click();
  await expect(tabsOf(page).getByRole("alert")).toHaveText("端末を作れませんでした（E2E）");

  const FOUR = id(4);
  daemon.handle("session.launch", (m) => {
    addsSession(daemon, tabSession(FOUR, "四つ目", 0));
    return commandResult(m, { ok: true, sessionId: FOUR });
  });
  await page.getByRole("button", { name: "この worktree で新しいセッションを起動" }).click();
  await expect(openTab(page)).toHaveText("四つ目");
  expect(daemon.received.filter((m) => m.type === "session.launch").at(-1)).toMatchObject({ cwd: WORKTREE.path });
  await expect(tabsOf(page).getByRole("button").filter({ hasText: /\S/ })).toHaveText(["一つ目", "二つ目", "三つ目", "四つ目"]);
});

test("タブの「＋」で信頼するかを聞かれると、確認を出し、信頼を選んだときだけ起動する", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub);
  const FOUR = id(4);
  daemon.handle("session.launch", (m) => {
    if (!m.trust) return commandResult(m, { ok: false, error: "このフォルダーは、まだ Claude Code に信頼されていません。", needsTrust: true, trustWarnings: ["hooks があります（E2E）"] });
    addsSession(daemon, tabSession(FOUR, "四つ目", 0));
    return commandResult(m, { ok: true, sessionId: FOUR });
  });
  const launches = () => daemon.received.filter((m) => m.type === "session.launch").map((m) => m.trust);
  const plus = page.getByRole("button", { name: "この worktree で新しいセッションを起動" });
  const ask = page.getByRole("dialog").getByRole("region", { name: "このフォルダーは、まだ Claude Code に信頼されていません" });

  await plus.click();
  await expect(ask.getByText(WORKTREE.path, { exact: true })).toBeVisible();
  await expect(ask.getByText("hooks があります（E2E）")).toBeVisible();
  await expect(tabsOf(page).getByRole("alert")).toHaveCount(0);
  await ask.getByRole("button", { name: "やめる" }).click();
  await expect(ask).toHaveCount(0);
  expect(launches()).toEqual([undefined]);
  // The form stays open for another folder; closing it leaves the tabs as they were.
  await page.getByRole("dialog").getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await plus.click();
  await ask.getByRole("button", { name: "信頼して起動する" }).click();
  await expect(openTab(page)).toHaveText("四つ目");
  expect(launches()).toEqual([undefined, undefined, true]);
});

test("タブのメニューが、Chromium では右クリックとコンテキストメニューのキー、WebKit では長押しで開く", async ({ page, hub }, testInfo) => {
  await openTabs(page, hub);

  const menu = await openMenu(page, tab(page, "一つ目"), testInfo);
  await expect(menu.getByText("一つ目", { exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["名前を変更…", "フォーク…", "削除…"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Not the open tab: the menu opened (on a touch screen, the finger lifted) without opening its session. (While the
  // menu is open, the rest of the page is hidden from the accessibility tree.)
  await expect(openTab(page)).toHaveText("二つ目");

  if (!testInfo.project.use.hasTouch) {
    await tab(page, "三つ目").focus();
    await page.keyboard.press("ContextMenu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("三つ目", { exact: true })).toBeVisible();
  }
});

test("名前を変更で、空・60 文字を超える名前・制御文字・変えていない名前を送れず、変えた名前が daemon に届く。警告が返ればその文が出る", async ({ page, hub }, testInfo) => {
  const daemon = await openTabs(page, hub);
  daemon.handle("session.rename", (m) => {
    daemon.updateSession(m.sessionId, { name: m.name });
    return commandResult(m, m.name === "警告の出る名前" ? { ok: true, warning: "作業が終わってから、Claude Code に /rename を送ります。" } : { ok: true });
  });

  await (await openMenu(page, tab(page, "二つ目"), testInfo)).getByRole("menuitem", { name: "名前を変更…" }).click();
  const dialog = page.getByRole("dialog", { name: "名前を変更" });
  const name = dialog.getByRole("textbox", { name: "名前", exact: true });
  const submit = dialog.getByRole("button", { name: "変更する" });
  await expect(name).toHaveValue("二つ目");
  await expect(submit).toBeDisabled();
  await name.fill("  二つ目  ");
  await expect(submit).toBeDisabled();
  await name.fill("");
  await expect(submit).toBeDisabled();
  // The field takes 60 characters, no more.
  await name.fill("あ".repeat(61));
  await expect(name).toHaveValue("あ".repeat(60));
  // A line break does not get into the field; another control character is refused.
  await name.fill("一行目\n二行目");
  expect(await name.inputValue()).not.toContain("\n");
  await name.fill("タブ\tの入った名前");
  await submit.click();
  await expect(dialog.getByText("名前に改行や制御文字は使えません。")).toBeVisible();
  expect(daemon.received.filter((m) => m.type === "session.rename")).toHaveLength(0);

  await name.fill("新しい名前");
  await submit.click();
  expect(await daemon.waitFor("session.rename")).toMatchObject({ sessionId: TWO, name: "新しい名前" });
  await expect(dialog).toHaveCount(0);
  await expect(openTab(page)).toHaveText("新しい名前");

  await (await openMenu(page, tab(page, "新しい名前"), testInfo)).getByRole("menuitem", { name: "名前を変更…" }).click();
  await name.fill("警告の出る名前");
  await submit.click();
  await expect(dialog.getByText("名前を変えました。")).toBeVisible();
  await expect(dialog.getByText("作業が終わってから、Claude Code に /rename を送ります。")).toBeVisible();
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(openTab(page)).toHaveText("警告の出る名前");
});

test("フォークの名前の初期値は「…のフォーク」で、フォークするとそのセッションを開く", async ({ page, hub }, testInfo) => {
  const daemon = await openTabs(page, hub, { open: ONE });
  const FORK = id(5);
  daemon.handle("session.fork", (m) => {
    addsSession(daemon, tabSession(FORK, m.name ?? "", 0));
    return commandResult(m, { ok: true, sessionId: FORK });
  });

  await (await openMenu(page, tab(page, "二つ目"), testInfo)).getByRole("menuitem", { name: "フォーク…" }).click();
  const dialog = page.getByRole("dialog", { name: "フォーク" });
  await expect(dialog.getByText("mac · /work/gasho")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveValue("二つ目 のフォーク");
  await dialog.getByRole("button", { name: "フォークする" }).click();
  expect(await daemon.waitFor("session.fork")).toMatchObject({ sessionId: TWO, name: "二つ目 のフォーク" });
  await expect(dialog).toHaveCount(0);
  await expect(openTab(page)).toHaveText("二つ目 のフォーク");
});

test("削除で、作業中・送信待ちの件数・開き直し方の文が出て、削除すると次のタブ、前のタブ、最後は worktree の画面を開く", async ({ page, hub }, testInfo) => {
  const daemon = await openTabs(page, hub, {
    sessions: [tabSession(ONE, "一つ目", 3 * HOUR), tabSession(TWO, "二つ目", 2 * HOUR, { status: "busy", pendingInputs: 2 }), tabSession(THREE, "三つ目", 1 * HOUR)],
  });
  daemon.handle("session.remove", (m) => {
    daemon.setSessions(daemon.sessions.filter((s) => s.sessionId !== m.sessionId));
    return commandResult(m);
  });
  const remove = async (name: string) => {
    await (await openMenu(page, tab(page, name), testInfo)).getByRole("menuitem", { name: "削除…" }).click();
    return page.getByRole("alertdialog", { name: "セッションを削除しますか？" });
  };

  let dialog = await remove("二つ目");
  await expect(dialog).toContainText("「二つ目」の Claude Code を終了し、Gasho の一覧から外します。作業の途中で止まります。送信待ちの 2 件は送りません。");
  await expect(dialog).toContainText("会話の記録は mac に残ります。タブの左の過去の会話から開き直せます。");
  await dialog.getByRole("button", { name: "削除する" }).click();
  expect(await daemon.waitFor("session.remove")).toMatchObject({ sessionId: TWO });
  await expect(dialog).toHaveCount(0);
  // The tab after it.
  await expect(openTab(page)).toHaveText("三つ目");

  // Without past conversations in Gasho, the terminal's way.
  daemon.setCapabilities({ canResume: false });
  dialog = await remove("三つ目");
  await expect(dialog).toContainText("「三つ目」の Claude Code を終了し、Gasho の一覧から外します。");
  await expect(dialog).not.toContainText("作業の途中で止まります");
  await expect(dialog).not.toContainText("送信待ち");
  await expect(dialog).toContainText("会話の記録は mac に残ります。端末で claude --resume を使うと開き直せます。");
  await dialog.getByRole("button", { name: "削除する" }).click();
  // The last tab: the one before it.
  await expect(openTab(page)).toHaveText("一つ目");

  dialog = await remove("一つ目");
  await dialog.getByRole("button", { name: "削除する" }).click();
  await expect(page.getByText("この worktree にセッションはありません。")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/w/${daemon.machineId}/`));
});

test("タブの × は、作業中と送信待ちのあるセッションでだけ確認を出し、ほかはすぐ削除して、削除できなければ理由を出す", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub, {
    open: ONE,
    sessions: [tabSession(ONE, "一つ目", 3 * HOUR), tabSession(TWO, "二つ目", 2 * HOUR, { status: "busy" }), tabSession(THREE, "三つ目", 1 * HOUR, { pendingInputs: 1 })],
  });
  let fail!: () => void;
  const failed = new Promise<void>((r) => (fail = r));
  let calls = 0;
  daemon.handle("session.remove", async (m) => {
    if (calls++ === 0) {
      await failed;
      return commandResult(m, { ok: false, error: "削除できませんでした（E2E）" });
    }
    daemon.setSessions(daemon.sessions.filter((s) => s.sessionId !== m.sessionId));
    return commandResult(m);
  });
  const close = (name: string) => tabsOf(page).getByRole("button", { name: `${name} を削除` });
  const dialog = page.getByRole("alertdialog", { name: "セッションを削除しますか？" });

  await close("二つ目").click();
  await expect(dialog).toContainText("作業の途中で止まります。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await close("三つ目").click();
  await expect(dialog).toContainText("送信待ちの 1 件は送りません。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  expect(daemon.received.filter((m) => m.type === "session.remove")).toHaveLength(0);

  // Nothing to stop: removed at once, and the × cannot be pressed again meanwhile.
  await close("一つ目").click();
  expect(await daemon.waitFor("session.remove")).toMatchObject({ sessionId: ONE });
  await expect(close("一つ目")).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  fail();
  // At the top of the screen: on a phone, the tabs' row has no room left for it.
  await expect(page.getByText("「一つ目」：削除できませんでした（E2E）")).toBeVisible();
  await expect(close("一つ目")).toBeEnabled();

  await close("一つ目").click();
  await expect(tab(page, "一つ目")).toHaveCount(0);
  // It was open: the tab after it opens.
  await expect(openTab(page)).toHaveText("二つ目");
  await expect(dialog).toHaveCount(0);
});

test("オフラインと gasho-daemon 0.9 未満では、メニューの項目を押せず、理由が出る", async ({ page, hub }, testInfo) => {
  const old = await hub.fakeDaemon({
    name: "old",
    version: "0.8.3",
    sessions: [fakeSession({ sessionId: id(7), cwd: "/work/old", name: "古いセッション", worktree: { path: "/work/old", repo: "/work/old", branch: "main" } })],
  });
  await page.goto(`/#/s/${old.machineId}/${id(7)}`);
  let menu = await openMenu(page, tab(page, "古いセッション"), testInfo);
  await expect(menu.getByText("old の gasho-daemon を 0.9.0 以上に更新すると使えます。")).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  for (const item of await menu.getByRole("menuitem").all()) await expect(item).toBeDisabled();
  await page.keyboard.press("Escape");

  // Forking starts Claude Code: only where sessions can be started.
  const daemon = await openTabs(page, hub, { daemon: { capabilities: { canLaunch: false } } });
  menu = await openMenu(page, tab(page, "二つ目"), testInfo);
  await expect(menu.getByRole("menuitem", { name: "名前を変更…" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: "フォーク…" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "削除…" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await daemon.disconnect();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();
  menu = await openMenu(page, tab(page, "二つ目"), testInfo);
  await expect(menu.getByText("mac はオフラインです。")).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  for (const item of await menu.getByRole("menuitem").all()) await expect(item).toBeDisabled();
});

/** A conversation of session.history, last written `ago` ms before now. */
const past = (sessionId: string, title: string | undefined, ago: number, cwd = WORKTREE.path) => ({ sessionId, ...(title ? { title } : {}), cwd, lastActivityAt: Date.now() - ago });

test("過去の会話は開くたびに読み直し、読み込み中・各行の題と時刻とフォルダー・0 件・エラーを出す", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub);
  let release!: () => void;
  const loaded = new Promise<void>((r) => (release = r));
  const answers = [
    { ok: true, history: [past(id(11), "前の会話", 3 * HOUR), past(id(12), undefined, 5 * 24 * HOUR, `${WORKTREE.path}/apps/web`)] },
    { ok: true, history: [] },
    { ok: false, error: "履歴を読めませんでした（E2E）" },
  ];
  let calls = 0;
  daemon.handle("session.history", async (m) => {
    const n = calls++;
    if (n === 0) await loaded;
    return commandResult(m, answers[n]);
  });
  const button = tabsOf(page).getByRole("button", { name: "過去の会話" });
  const popover = page.getByRole("dialog");

  await button.click();
  await expect(popover.getByText("読み込んでいます…")).toBeVisible();
  expect(await daemon.waitFor("session.history")).toMatchObject({ cwd: WORKTREE.path, subfolders: true });
  release();
  await expect(popover.getByRole("button", { name: /前の会話/ })).toContainText("3 時間前");
  // In a folder inside the worktree, which the row names.
  await expect(popover.getByRole("button", { name: /（題のない会話）/ })).toContainText("5 日前 · apps/web");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  await button.click();
  await expect(popover.getByText("開いていない過去の会話はありません。")).toBeVisible();
  await page.keyboard.press("Escape");

  await button.click();
  await expect(popover.getByText("履歴を読めませんでした（E2E）")).toBeVisible();
  expect(daemon.received.filter((m) => m.type === "session.history")).toHaveLength(3);
});

test("過去の会話を押すと開き直し、警告が返ったときは「開く」で開く", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub);
  const first = past(id(21), "前の会話", HOUR);
  const second = past(id(22), "その前の会話", 2 * HOUR);
  const third = past(id(23), "開けない会話", 3 * HOUR);
  daemon.handle("session.history", (m) => commandResult(m, { ok: true, history: [first, second, third] }));
  daemon.handle("session.resume", (m) => {
    if (m.sessionId === third.sessionId) return commandResult(m, { ok: false, error: "会話のファイルがありません（E2E）" });
    const c = m.sessionId === first.sessionId ? first : second;
    addsSession(daemon, tabSession(c.sessionId, c.title ?? "", 0));
    return commandResult(m, { ok: true, sessionId: c.sessionId, ...(c === second ? { warning: "前と同じモデルにできませんでした。" } : {}) });
  });
  const button = tabsOf(page).getByRole("button", { name: "過去の会話" });
  const popover = page.getByRole("dialog");

  await button.click();
  await popover.getByRole("button", { name: /^前の会話/ }).click();
  expect(await daemon.waitFor("session.resume")).toMatchObject({ sessionId: first.sessionId });
  await expect(popover).toHaveCount(0);
  await expect(openTab(page)).toHaveText("前の会話");

  await button.click();
  await popover.getByRole("button", { name: /^その前の会話/ }).click();
  await expect(popover.getByText("前と同じモデルにできませんでした。")).toBeVisible();
  // Not opened until "開く".
  await expect(openTab(page)).toHaveText("前の会話");
  await popover.getByRole("button", { name: "開く" }).click();
  await expect(openTab(page)).toHaveText("その前の会話");

  await button.click();
  await popover.getByRole("button", { name: /^開けない会話/ }).click();
  await expect(popover.getByText("会話のファイルがありません（E2E）")).toBeVisible();
});

test("canResume の無い daemon と、接続が無いときは、過去の会話を押せない", async ({ page, hub }) => {
  const daemon = await openTabs(page, hub, { daemon: { capabilities: { canResume: false } } });
  const button = tabsOf(page).getByRole("button", { name: "過去の会話" });
  await expect(button).toBeDisabled();
  daemon.setCapabilities({ canResume: true });
  await expect(button).toBeEnabled();
  await daemon.disconnect();
  await expect(button).toBeDisabled();
});

test("Gasho の外の会話があると「Gasho に移す」が出て、確認のダイアログで終了させると、終わった件数の文が出る", async ({ page, hub }) => {
  const outside = (sessionId: string, title: string, ago: number, o: Partial<SessionInfo> = {}) =>
    tabSession(sessionId, "", ago, { name: undefined, title, managed: false, pid: 4000 + ago / HOUR, ...o });
  const daemon = await openTabs(page, hub, {
    open: ONE,
    sessions: [
      tabSession(ONE, "一つ目", 3 * HOUR),
      outside(id(31), "Orca の会話", 2 * HOUR, { status: "busy" }),
      outside(id(32), "端末の会話", 1 * HOUR),
      // Not running (no process): nothing to end.
      outside(id(33), "終わった会話", 4 * HOUR, { pid: undefined }),
    ],
    daemon: { capabilities: { canEnd: false } },
  });
  daemon.handle("session.end", (m) => {
    daemon.setSessions(daemon.sessions.filter((s) => !m.sessionIds.includes(s.sessionId)));
    return commandResult(m, { ok: true, ended: m.sessionIds });
  });

  await expect(page.getByText("Gasho の外で 2 件の会話が開いています")).toBeVisible();
  // Only a gasho-daemon that can end them.
  const move = page.getByRole("button", { name: "Gasho に移す" });
  await expect(move).toBeDisabled();
  daemon.setCapabilities({ canEnd: true });
  await expect(move).toBeEnabled();

  await move.click();
  const dialog = page.getByRole("alertdialog", { name: "この worktree の会話を Gasho に移しますか？" });
  await expect(dialog.getByRole("listitem")).toHaveText([/Orca の会話/, /端末の会話/]);
  await expect(dialog).toContainText("作業中の会話は、作業が途中で止まります。");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect(daemon.received.filter((m) => m.type === "session.end")).toHaveLength(0);

  await move.click();
  await dialog.getByRole("button", { name: "終了する" }).click();
  expect(await daemon.waitFor("session.end")).toMatchObject({ sessionIds: [id(31), id(32)] });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("2 件の会話の Claude Code を終了しました。タブの左の過去の会話から、Gasho で開き直せます。")).toBeVisible();
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByText(/Gasho の外で|件の会話の Claude Code を終了しました/)).toHaveCount(0);
});
