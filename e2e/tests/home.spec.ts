/// <reference lib="dom" />
// The home screen: its heading and tiles, the sessions' cards, the notifications, the latest operations, the number
// tiles' charts, the tiles' order and the columns of the grid, with fake gasho-daemons.
import type { Page } from "@playwright/test";
import type { FakeDaemon } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { drag, pointOn, sendHook, startDrag, worktreeSession } from "./home-sidebar.ts";

test.describe.configure({ mode: "parallel" });

const TILES = ["作業中", "確認待ち", "待機中", "送った指示", "セッション", "通知", "トークン", "トークンの内訳", "最近の操作", "working server", "メモリ"];

/** The tiles' names, in the order shown (their handles are named after them). */
const tileOrder = (page: Page) =>
  page.getByRole("button", { name: /^「.+」を移動$/ }).evaluateAll((els) => els.map((e) => /^「(.+)」を移動$/.exec(e.getAttribute("aria-label") ?? "")?.[1]));

/** A tile of the home screen with a heading ("セッション", "最近の操作", "working server"). */
const tile = (page: Page, title: string) => page.getByRole("main").locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

/** The notifications' tile, by its heading line ("通知（2）"). */
const notificationTile = (page: Page) => page.getByRole("main").locator("section").filter({ hasText: /^通知（\d+）/ });

/** A number tile, read out as "作業中：2" or "トークン：3,000" (and how it compares with the 24 hours before, if it does). */
const numberTile = (page: Page, label: string, value?: number | string) =>
  page.getByRole("group", { name: value === undefined ? new RegExp(`^${label}：`) : new RegExp(`^${label}：${value}(、|$)`) });

/** How many columns the tiles' grid has now. */
const columns = (page: Page) =>
  page.getByRole("button", { name: "「作業中」を移動" }).evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).gridTemplateColumns.split(" ").length);

test.describe("見出しとタイル", () => {
  test("見出しに working server の台数と Gasho から起動したセッションの数が出て、タイルが 11 枚並ぶ", async ({ page, hub }) => {
    const busy = worktreeSession("busy-one", { status: "busy" });
    const waiting = worktreeSession("waiting-one", { status: "waiting" });
    const idle = worktreeSession("idle-one", { status: "idle" });
    // Claude Code started in a terminal: counted nowhere on the home screen.
    const outside = worktreeSession("outside-one", { status: "busy", managed: false, pid: 4242 });
    await hub.fakeDaemon({ name: "mac", sessions: [busy, waiting, idle, outside] });
    const ubuntu = await hub.fakeDaemon({ name: "ubuntu", sessions: [worktreeSession("offline-one", { status: "busy" })] });
    await ubuntu.disconnect();

    await page.goto("/");
    await expect(page.getByRole("main").getByText("2 台の working server・4 セッション")).toBeVisible();
    expect(await tileOrder(page)).toEqual(TILES);
    // The states count the sessions of the working servers online, and name them.
    await expect(numberTile(page, "作業中", 1)).toContainText("busy-one");
    await expect(numberTile(page, "確認待ち", 1)).toContainText("waiting-one");
    await expect(numberTile(page, "待機中", 1)).toContainText("idle-one");
    await expect(tile(page, "セッション").getByRole("listitem")).toHaveCount(4);
    await expect(tile(page, "セッション")).not.toContainText("outside-one");
    await expect(tile(page, "working server")).toContainText("接続中・セッション 3");
    await expect(tile(page, "working server")).toContainText(/オフライン・最後の接続/);
  });

  test("何もないときは、どのタイルも 0 件の文を出す", async ({ page }) => {
    await page.goto("/");
    const main = page.getByRole("main");
    await expect(main.getByText("0 台の working server・0 セッション")).toBeVisible();
    await expect(main.getByText("Gasho から起動したセッションはまだありません。")).toBeVisible();
    await expect(main.getByText("まだ操作はありません。")).toBeVisible();
    for (const title of ["working server", "メモリ"]) await expect(tile(page, title).getByText("登録された working server はありません。")).toBeVisible();
    await expect(main.getByText("新しい通知はありません")).toBeVisible();
    await expect(main.getByText("過去24時間に使ったトークンはありません。")).toBeVisible();
    for (const label of ["作業中", "確認待ち", "待機中", "送った指示"]) await expect(numberTile(page, label, 0)).toBeVisible();
    await expect(numberTile(page, "作業中", 0)).toContainText("なし");
  });

  test("「新しいセッション」で、ホームの上に起動フォームが開き、閉じると元に戻る", async ({ page }) => {
    await page.goto("/");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "新しいセッション" }).click();
    await expect(main.getByRole("heading", { name: "新しいセッションを起動する" })).toBeVisible();
    // The form takes the button's place, above the tiles.
    await expect(main.getByRole("button", { name: "新しいセッション" })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/$|\/$/);
    await main.getByRole("button", { name: "閉じる" }).click();
    await expect(main.getByRole("heading", { name: "新しいセッションを起動する" })).toHaveCount(0);
    // The sessions' tile opens it too while there are none.
    await main.getByRole("button", { name: "セッションを起動する" }).click();
    await expect(main.getByRole("heading", { name: "新しいセッションを起動する" })).toBeVisible();
  });
});

test.describe("セッションのカード", () => {
  test("確認待ちは琥珀色の枠と待っているものの文、オフラインはその札、ほかに設定・送信待ち・トークン・費用の札が出る", async ({ page, hub }) => {
    const question = worktreeSession("question", {
      status: "waiting",
      permissionRequests: [{ id: "q1", toolName: "AskUserQuestion", input: "{}", at: Date.now(), questions: [{ question: "どちらにしますか", options: [{ label: "A" }, { label: "B" }] }] }],
    });
    const plan = worktreeSession("plan", { status: "waiting", permissionRequests: [{ id: "p1", toolName: "ExitPlanMode", input: "{}", at: Date.now(), plan: "# 計画" }] });
    const permission = worktreeSession("permission", { status: "waiting", waitingFor: "permission prompt" });
    const chips = worktreeSession("chips", {
      status: "busy",
      model: "Opus 4.7 (default)",
      effort: "xhigh",
      ultracode: true,
      pendingInputs: 2,
      tokens: { input: 12_000, output: 3_000, cacheWrite: 0, cacheRead: 0 },
      costUSD: 1.234,
    });
    await hub.fakeDaemon({ name: "mac", sessions: [question, plan, permission, chips] });
    const ubuntu = await hub.fakeDaemon({ name: "ubuntu", sessions: [worktreeSession("gone", { status: "waiting" })] });
    await ubuntu.disconnect();

    await page.goto("/");
    const cards = tile(page, "セッション");
    const card = (name: string) => cards.getByRole("button", { name: new RegExp(`\\b${name}\\b`) });
    await expect(card("question")).toContainText("質問への回答を待っています");
    await expect(card("plan")).toContainText("計画の承認を待っています");
    await expect(card("permission")).toContainText("権限の確認");
    for (const name of ["question", "plan", "permission"]) await expect(card(name)).toHaveClass(/ring-amber-500/);
    // Offline, a session waits for nobody: no amber, no words of waiting.
    await expect(card("gone")).toContainText("オフライン");
    await expect(card("gone")).not.toHaveClass(/ring-amber-500/);
    await expect(card("gone")).not.toContainText("待っています");
    await expect(card("chips")).not.toHaveClass(/ring-amber-500/);
    for (const text of ["Opus 4.7", "xHigh", "Ultracode", "送信待ち 2", "1.5万 トークン", "$1.23"]) await expect(card("chips")).toContainText(text);
    await expect(card("chips")).not.toContainText("(default)");
    // Waiting first, then working, idle, and offline last.
    await expect(cards.getByRole("listitem")).toHaveText([/question|plan|permission/, /question|plan|permission/, /question|plan|permission/, /chips/, /gone/]);

    await card("plan").click();
    await expect(page.getByRole("heading", { name: "plan" })).toBeVisible();
  });

  test("10 件以上のセッションは 9 件まで出て、「すべて表示（n）」と「少なく表示」で切り替わる", async ({ page, hub }) => {
    const now = Date.now();
    await hub.fakeDaemon({ sessions: Array.from({ length: 10 }, (_, i) => worktreeSession(`s${i + 1}`, { lastActivityAt: now - i * 60_000 })) });
    await page.goto("/");
    const cards = tile(page, "セッション").getByRole("listitem");
    await expect(cards).toHaveCount(9);
    // The one used longest ago is left out.
    await expect(tile(page, "セッション")).not.toContainText("s10");
    await page.getByRole("button", { name: "すべて表示（10）" }).click();
    await expect(cards).toHaveCount(10);
    await page.getByRole("button", { name: "少なく表示" }).click();
    await expect(cards).toHaveCount(9);
  });
});

test.describe("通知", () => {
  /** Three sessions, each with a notification that its reply ended. */
  async function threeNotifications(hub: { fakeDaemon: (o: object) => Promise<FakeDaemon> }) {
    const sessions = ["alpha", "bravo", "charlie"].map((n) => worktreeSession(n));
    const daemon = await hub.fakeDaemon({ name: "mac", sessions });
    for (const s of sessions) sendHook(daemon, s.sessionId, "Stop", { summary: `${s.name} の答え` });
    return { daemon, sessions };
  }

  test("本文を押すと既読になってセッションが開き、× でも既読になる。2 件以上で「すべて表示」「重ねる」", async ({ page, hub }) => {
    await threeNotifications(hub);
    await page.goto("/");
    const stack = notificationTile(page);
    await expect(stack).toContainText("通知（3）");
    await stack.getByRole("button", { name: "すべて表示" }).click();
    for (const n of ["alpha", "bravo", "charlie"]) await expect(stack.getByRole("heading", { name: `${n} の応答が終わりました` })).toBeVisible();
    await expect(stack.getByText("bravo の答え")).toBeVisible();
    await stack.getByRole("button", { name: "重ねる" }).click();
    await expect(stack.getByRole("button", { name: "すべて表示" })).toBeVisible();

    // Stacked, the one on top is the one that can be pressed.
    const top = stack.getByRole("heading", { name: /の応答が終わりました/ }).first();
    const opened = (await top.textContent())?.replace(" の応答が終わりました", "") ?? "";
    await stack.getByRole("button", { name: /の応答が終わりました/ }).first().click();
    await expect(page.getByRole("heading", { name: opened })).toBeVisible();
    await page.goto("/");
    await expect(stack).toContainText("通知（2）");
    await expect(stack).not.toContainText(`${opened} の応答`);

    const dismissed = await top.textContent();
    await stack.getByRole("button", { name: "既読にする" }).first().click();
    await expect(stack).toContainText("通知（1）");
    await expect(stack).not.toContainText(dismissed ?? "");
    await stack.getByRole("button", { name: "既読にする" }).click();
    await expect(stack).toContainText("通知（0）");
    await expect(stack.getByText("新しい通知はありません")).toBeVisible();
  });

  test("右へドラッグすると既読になり、ホームのまま", async ({ page, hub, isMobile }) => {
    test.fail(!isMobile, "マウスで右へドラッグすると、既読になったうえで、その通知のセッションが開く（ドラッグの終わりの click が本文に届く。#182）");
    await threeNotifications(hub);
    await page.goto("/");
    const stack = notificationTile(page);
    await expect(stack).toContainText("通知（3）");
    const top = stack.getByRole("heading", { name: /の応答が終わりました/ }).first();
    const dragged = (await top.textContent()) ?? "";
    await drag(page, isMobile, top, await pointOn(top, 120, 0));
    await expect(stack).toContainText("通知（2）");
    await expect(stack).not.toContainText(dragged);
    await expect(page.getByRole("main").getByRole("heading", { name: "ホーム" })).toBeVisible();
  });

  test("既読にした通知は、別のブラウザーでも既読になる", async ({ page, hub, browser }) => {
    await threeNotifications(hub);
    const other = await browser.newContext();
    await other.addCookies([await hub.browserCookie("e2e-other-browser")]);
    const otherPage = await other.newPage();
    try {
      await otherPage.goto(hub.url);
      await expect(notificationTile(otherPage)).toContainText("通知（3）");
      await page.goto("/");
      await notificationTile(page).getByRole("button", { name: "既読にする" }).first().click();
      await expect(notificationTile(page)).toContainText("通知（2）");
      await expect(notificationTile(otherPage)).toContainText("通知（2）");
    } finally {
      await other.close();
    }
  });

  test("通知の文は hook で変わり、Gasho の外のセッションには通知を作らず、開いて見ているセッションの通知は既読になる", async ({ page, hub }) => {
    const done = worktreeSession("done");
    const failed = worktreeSession("failed");
    const asking = worktreeSession("asking");
    const planning = worktreeSession("planning");
    const permitting = worktreeSession("permitting");
    const idle = worktreeSession("idle");
    const watched = worktreeSession("watched");
    const outside = worktreeSession("outside", { managed: false, pid: 4242 });
    const daemon = await hub.fakeDaemon({ name: "mac", sessions: [done, failed, asking, planning, permitting, idle, watched, outside] });

    await page.goto("/");
    // The hooks of a session started elsewhere come first: by the time the others' notifications show, it is known
    // that it made none.
    sendHook(daemon, outside.sessionId, "Stop", { summary: "外の答え" });
    sendHook(daemon, done.sessionId, "Stop", { summary: "README を読みました。" });
    sendHook(daemon, failed.sessionId, "StopFailure", { summary: "API Error: 529" });
    // Claude Code says "needs your permission" for a question and a plan too: the request it is about tells which.
    daemon.updateSession(asking.sessionId, {
      status: "waiting",
      permissionRequests: [
        { id: "q1", toolName: "AskUserQuestion", input: "{}", summary: "どの色にしますか", at: Date.now(), questions: [{ question: "どの色にしますか", options: [{ label: "青" }] }] },
      ],
    });
    sendHook(daemon, asking.sessionId, "Notification", { notificationType: "permission_prompt", summary: "Claude needs your permission" });
    daemon.updateSession(planning.sessionId, {
      status: "waiting",
      permissionRequests: [{ id: "p1", toolName: "ExitPlanMode", input: "{}", summary: "テストを足す計画", at: Date.now(), plan: "# テストを足す計画" }],
    });
    sendHook(daemon, planning.sessionId, "Notification", { notificationType: "permission_prompt", summary: "Claude needs your permission" });
    sendHook(daemon, permitting.sessionId, "Notification", { notificationType: "permission_prompt", summary: "Bash: npm test" });
    sendHook(daemon, idle.sessionId, "Notification", { notificationType: "idle_prompt", summary: "Claude is waiting for your input" });

    const stack = notificationTile(page);
    await expect(stack).toContainText("通知（6）");
    await stack.getByRole("button", { name: "すべて表示" }).click();
    const expected: [string, string][] = [
      ["done の応答が終わりました", "README を読みました。"],
      ["failed がエラーで止まりました", "API Error: 529"],
      ["asking が質問しています", "どの色にしますか"],
      ["planning が計画の承認を待っています", "テストを足す計画"],
      ["permitting が権限の確認を待っています", "Bash: npm test"],
      ["idle が入力を待っています", "Claude is waiting for your input"],
    ];
    for (const [title, body] of expected) await expect(stack.getByRole("button", { name: title })).toContainText(body);
    await expect(stack).not.toContainText("outside");

    // Open on the screen, a session's new notification is read at once.
    await tile(page, "セッション").getByRole("button", { name: /\bwatched\b/ }).click();
    await expect(page.getByRole("heading", { name: "watched" })).toBeVisible();
    sendHook(daemon, watched.sessionId, "Stop", { summary: "見ていた答え" });
    await page.goto("/");
    await expect(stack).toContainText("通知（6）");
    await expect(stack).not.toContainText("watched");
  });
});

test.describe("最近の操作と送った指示", () => {
  /** Sends instructions from the session's screen, each once the fake daemon has it. */
  async function sendInstructions(page: Page, daemon: FakeDaemon, sessionId: string, texts: string[]) {
    for (const text of texts) {
      await page.getByPlaceholder("Agent への指示を入力…").fill(text);
      await page.getByRole("button", { name: "送信" }).click();
      await daemon.waitFor("session.input", (m) => m.sessionId === sessionId && m.text === text);
    }
  }

  test("最新の 6 件が出て、押すとそのセッションが開く。ツールのイベントがいくつ来ても、送った指示と最近の操作の数は変わらない（#107）", async ({ page, hub }) => {
    test.slow();
    const s = worktreeSession("worker");
    const daemon = await hub.fakeDaemon({ name: "mac", sessions: [s] });
    await page.goto("/");
    await tile(page, "セッション").getByRole("button", { name: /\bworker\b/ }).click();
    const texts = Array.from({ length: 7 }, (_, i) => `指示 ${i + 1}`);
    await sendInstructions(page, daemon, s.sessionId, texts);

    await page.goto("/");
    const operations = tile(page, "最近の操作").getByRole("listitem");
    const latestSix = texts.slice(1).reverse().map((t) => new RegExp(`^${t}worker · `));
    await expect(operations).toHaveText(latestSix);
    const sent = numberTile(page, "送った指示", 7);
    await expect(sent).toContainText("過去24時間");
    // All sent in the latest 2 hours.
    await sent.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(sent.getByRole("status")).toHaveText(/^\d{2}:\d{2}〜\d{2}:\d{2}：7$/);
    await expect(sent).not.toContainText("過去24時間");
    await page.keyboard.press("Escape");
    await expect(sent).toContainText("過去24時間");

    // Claude Code's tools send two hooks a call: far more than the screen keeps of the events.
    for (let i = 0; i < 200; i++) {
      sendHook(daemon, s.sessionId, "PreToolUse", { toolName: "Bash", summary: `npm test ${i}` });
      sendHook(daemon, s.sessionId, "PostToolUse", { toolName: "Bash", summary: `npm test ${i}` });
    }
    sendHook(daemon, s.sessionId, "Stop", { summary: "終わりました" });
    await expect(notificationTile(page)).toContainText("通知（1）");
    await expect(operations).toHaveText(latestSix);
    await expect(numberTile(page, "送った指示", 7)).toBeVisible();
    // From the Gasho server's records, after a reload.
    await page.reload();
    await expect(operations).toHaveText(latestSix);
    await expect(numberTile(page, "送った指示", 7)).toBeVisible();

    await operations.first().getByRole("button").click();
    await expect(page.getByRole("heading", { name: "worker" })).toBeVisible();
  });
});

test.describe("数のタイルのグラフ", () => {
  test("ホバーか ←/→ で各時間帯の値が出て、Esc で元に戻る", async ({ page, hub, isMobile }) => {
    const hour = 3600_000;
    const hourNow = Math.floor(Date.now() / hour) * hour;
    // Fixed at the middle of this hour: the hours of the tokens stay in the 2-hour steps they are put in.
    await page.clock.install({ time: hourNow + 30 * 60_000 });
    const usage = (input: number) => ({ input, output: 0, cacheWrite: 0, cacheRead: 0 });
    const s = worktreeSession("worker", { tokenHours: [[hourNow - 4 * hour, usage(2_000)], [hourNow, usage(1_000)]], tokens: usage(3_000) });
    await hub.fakeDaemon({ sessions: [s] });
    await page.goto("/");

    const tokens = numberTile(page, "トークン", "3,000");
    await expect(tokens).toContainText("過去24時間（サブエージェントを含む）");
    const said = tokens.getByRole("status");
    await tokens.focus();
    // From the latest 2 hours back: 1,000, then none, then the 2,000 of 4 hours ago.
    await page.keyboard.press("ArrowLeft");
    await expect(said).toHaveText(/^\d+時〜\d+時：1,000$/);
    await expect(tokens).not.toContainText("過去24時間（サブエージェントを含む）");
    await page.keyboard.press("ArrowLeft");
    await expect(said).toHaveText(/：0$/);
    await page.keyboard.press("ArrowLeft");
    await expect(said).toHaveText(/：2,000$/);
    await page.keyboard.press("ArrowRight");
    await expect(said).toHaveText(/：0$/);
    await page.keyboard.press("Escape");
    await expect(said).toHaveText("");
    await expect(tokens).toContainText("過去24時間（サブエージェントを含む）");

    // Over the chart's left end: the first 2 hours of the 24.
    const chart = tokens.getByRole("img", { name: /トークン の推移/ });
    const leftEnd = { x: 2, y: ((await chart.boundingBox())?.height ?? 0) / 2 };
    if (isMobile) await chart.tap({ position: leftEnd });
    else await chart.hover({ position: leftEnd });
    await expect(said).toHaveText(/^\d+時〜\d+時：0$/);
  });
});

test.describe("タイルの並べ替え", () => {
  test("つまみのドラッグと、矢印キー・Home・End で並びが変わり、読み込み直しても残り、「並びを元に戻す」で戻る", async ({ page, isMobile }) => {
    await page.goto("/");
    const handle = (name: string) => page.getByRole("button", { name: `「${name}」を移動` });
    const said = page.getByRole("main").locator("p[aria-live]").last();

    await handle("作業中").focus();
    await page.keyboard.press("ArrowRight");
    expect(await tileOrder(page)).toEqual(["確認待ち", "作業中", ...TILES.slice(2)]);
    await expect(said).toHaveText(`「作業中」を 2 番目に移動しました（全 ${TILES.length} 件）`);
    await expect(handle("作業中")).toBeFocused();
    await page.keyboard.press("End");
    expect(await tileOrder(page)).toEqual([...TILES.filter((t) => t !== "作業中"), "作業中"]);
    await page.keyboard.press("Home");
    expect(await tileOrder(page)).toEqual(TILES);
    // Back in the default order, nothing is kept.
    await expect(page.getByRole("button", { name: "並びを元に戻す" })).toHaveCount(0);

    // "送った指示" dropped on the left half of "作業中": first. From the top of the home screen: the keys scrolled it to
    // the tiles moved, and near the window's top edge a drag scrolls the home screen under the pointer.
    await page.getByRole("main").evaluate((el) => el.scrollTo(0, 0));
    const target = numberTile(page, "作業中");
    const leftHalf = await pointOn(target, -((await target.boundingBox())?.width ?? 0) / 4, 0);
    await handle("送った指示").hover();
    const d = await startDrag(page, isMobile, handle("送った指示"));
    await d.to(leftHalf);
    const moved = ["送った指示", "作業中", "確認待ち", "待機中", ...TILES.slice(4)];
    await expect.poll(() => tileOrder(page)).toEqual(moved);
    await d.drop();
    await expect(page.getByRole("button", { name: "並びを元に戻す" })).toBeVisible();
    await page.reload();
    await expect(handle("作業中")).toBeAttached();
    expect(await tileOrder(page)).toEqual(moved);
    await page.getByRole("button", { name: "並びを元に戻す" }).click();
    expect(await tileOrder(page)).toEqual(TILES);
    await page.reload();
    await expect(handle("作業中")).toBeAttached();
    expect(await tileOrder(page)).toEqual(TILES);
  });
});

test.describe("列の数", () => {
  test("ホームの幅に応じて 2〜5 列になる（サイドバーを畳むと、その分ホームが広がる）", async ({ page, isMobile }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "「作業中」を移動" })).toBeAttached();
    if (isMobile) {
      await expect.poll(() => columns(page)).toBe(2);
      return;
    }
    // The default sidebar (248px) beside it.
    await expect.poll(() => columns(page)).toBe(4);
    for (const [width, n] of [
      [1500, 5],
      [1100, 3],
      [880, 2],
      // A phone's layout, without the sidebar: 3 columns fit.
      [700, 3],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => columns(page), { message: `${width}px` }).toBe(n);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect.poll(() => columns(page)).toBe(3);
    await page.getByRole("button", { name: "サイドバーを畳む" }).click();
    await expect.poll(() => columns(page)).toBe(4);
  });
});

test.describe("時刻で変わる表示", () => {
  test("セッションのカードと通知の時刻が、時間が経つと変わる", async ({ page, hub }) => {
    await page.clock.install();
    const s = worktreeSession("worker", { lastActivityAt: Date.now() });
    const daemon = await hub.fakeDaemon({ sessions: [s] });
    sendHook(daemon, s.sessionId, "Stop", { summary: "答え" });
    await page.goto("/");
    const card = tile(page, "セッション").getByRole("button", { name: /\bworker\b/ });
    await expect(card).toContainText("たった今");
    await expect(notificationTile(page).getByRole("button", { name: /worker の応答が終わりました/ })).toContainText("たった今");
    await page.clock.fastForward("10:00");
    await expect(card).toContainText(/10\s?分前/);
    await expect(notificationTile(page).getByRole("button", { name: /worker の応答が終わりました/ })).toContainText(/10\s?分前/);
  });
});
