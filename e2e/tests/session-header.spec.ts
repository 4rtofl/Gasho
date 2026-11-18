// The session screen's header, and what it shows instead of a session it does not show.
import { fakeSession, textEntry } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { chatBox, OTHER_SESSION_ID, openSession, SESSION_ID, sessionPath } from "./session-helpers.ts";

test("Gasho の外のセッションと見つからないセッションは、理由の文と「ホーム」だけを出す", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, {
    session: { managed: false, name: "outside" },
  });
  const main = page.getByRole("main");
  await expect(main.getByText("このセッションは Gasho から起動したものではないので、表示しません。")).toBeVisible();
  await expect(main.getByRole("button", { name: "ホーム", exact: true })).toBeVisible();
  await expect(chatBox(page)).toHaveCount(0);

  await page.goto(sessionPath(daemon, OTHER_SESSION_ID));
  await expect(main.getByText("このセッションは見つかりません。終了したか、mac の gasho-daemon が接続していません。")).toBeVisible();
  await expect(chatBox(page)).toHaveCount(0);

  await main.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page).toHaveURL(/#\/$/);
});

test("オフラインのセッションを、読み込み直したあとに開いても「読み込み中…」のまま止まらない", async ({ page, hub }) => {
  test.fail(true, "#179: 画面は working server がつながっているときだけ会話を頼むので、オフラインのまま読み込み直すと「読み込み中…」が消えない");
  const daemon = await openSession(page, hub, { transcript: [textEntry("assistant", "前の返事")] });
  await expect(page.getByText("前の返事")).toBeVisible();
  await daemon.disconnect();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();

  await page.reload();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden();
});

test("ヘッダーに、マシン名・フォルダー・状態・確認待ち・GitHub・ブランチ・PR・最終更新・費用を出す", async ({ page, hub, isMobile }) => {
  const now = Date.now();
  await page.clock.install({ time: now });
  const github = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };
  const daemon = await openSession(page, hub, {
    session: {
      status: "waiting",
      waitingFor: "permission prompt",
      github,
      gitBranch: "feat/131-chat",
      prLinks: [{ number: 175, url: "https://github.com/4rtofl/Gasho/pull/175", repository: "4rtofl/Gasho" }],
      costUSD: 1.234,
      lastActivityAt: now - 5 * 60_000,
    },
  });
  // A phone opens the session with its header closed; its top bar has the name and the state.
  if (isMobile) await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  // The name and the state: in the header on a computer, in the top bar on a phone. The session's tab has its state too.
  const nameAndState = isMobile ? page.getByRole("banner") : page.getByRole("main").locator("header");
  await expect(nameAndState.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  await expect(nameAndState.getByText("確認待ち", { exact: true })).toBeVisible();
  await expect(page.getByText("mac · /work/gasho")).toBeVisible();
  await expect(page.getByText("権限の確認", { exact: true })).toBeVisible();

  const repo = page.getByRole("link", { name: "4rtofl/Gasho" });
  await expect(repo).toHaveAttribute("href", github.url);
  await expect(repo).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("button", { name: "feat/131-chat" })).toBeVisible();
  await expect(page.getByRole("link", { name: "feat/131-chat を GitHub で開く" })).toHaveAttribute("href", `${github.url}/tree/feat/131-chat`);
  await expect(page.getByRole("link", { name: "#175" })).toHaveAttribute("href", "https://github.com/4rtofl/Gasho/pull/175");
  await expect(page.getByText("最終更新 5 分前")).toBeVisible();
  await expect(page.getByText("費用 $1.23")).toBeVisible();

  // The times move on without the session changing.
  await page.clock.fastForward("10:00");
  await expect(page.getByText("最終更新 15 分前")).toBeVisible();

  // A session that is no longer waiting has no waiting text; one that works shows its dot alone.
  daemon.updateSession(SESSION_ID, { status: "busy", waitingFor: undefined });
  await expect(nameAndState.getByRole("img", { name: "作業中" })).toBeVisible();
  await expect(page.getByText("権限の確認", { exact: true })).toHaveCount(0);

  // The branch opens the branch graph beside the session (in its place on a phone).
  await page.getByRole("button", { name: "feat/131-chat" }).click();
  await expect(page).toHaveURL(/\/graph$/);
});

test("2 つ以上のリポジトリがあるフォルダーでは「複数のリポジトリ…」と「ブランチ…」を出し、1 つならそのリポジトリを出す", async ({ page, hub, isMobile }) => {
  const app = { owner: "4rtofl", name: "app", url: "https://github.com/4rtofl/app" };
  const daemon = await openSession(page, hub, {
    session: {
      cwd: "/work/repos",
      repos: [
        { path: "app", branch: "main", github: app },
        { path: "lib", branch: "dev" },
      ],
    },
  });
  if (isMobile) await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await page.getByRole("button", { name: "複数のリポジトリ…" }).click();
  await expect(page.getByRole("link", { name: /4rtofl\/app/ })).toHaveAttribute("href", app.url);
  await expect(page.getByText("lib", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "ブランチ…" })).toBeVisible();

  daemon.updateSession(SESSION_ID, { repos: [{ path: "app", branch: "main", github: app }] });
  await expect(page.getByRole("link", { name: "4rtofl/app" })).toHaveAttribute("href", app.url);
  await expect(page.getByRole("button", { name: "main", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "複数のリポジトリ…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ブランチ…" })).toHaveCount(0);

  // Its branch opens the branch graph of that repository.
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect(page).toHaveURL(/\/graph\/app$/);
});

test("「ファイル」は gasho-daemon 0.11 以上のセッションにだけ出る", async ({ page, hub, isMobile }) => {
  const old = await hub.fakeDaemon({ name: "old", version: "0.10.0", sessions: [fakeSession({ sessionId: SESSION_ID, cwd: "/work/old", name: "old-session" })] });
  const now = await hub.fakeDaemon({ name: "new", version: "0.11.0", sessions: [fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/new", name: "new-session" })] });

  await page.goto(sessionPath(old, SESSION_ID));
  if (isMobile) await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await expect(page.getByText("old · /work/old")).toBeVisible();
  await expect(page.getByRole("button", { name: "ファイル", exact: true })).toHaveCount(0);

  await page.goto(sessionPath(now, OTHER_SESSION_ID));
  if (isMobile) await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await expect(page.getByText("new · /work/new")).toBeVisible();
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
});

test("768px 以上では、ヘッダーを閉じると読み込み直しても閉じたまま", async ({ page, hub, isMobile }) => {
  test.skip(isMobile, "768px 以上の幅の動き");
  await openSession(page, hub);
  await expect(page.getByText("mac · /work/gasho")).toBeVisible();
  await page.getByRole("button", { name: "ヘッダーを隠す" }).click();
  await expect(page.getByText("mac · /work/gasho")).toBeHidden();
  // The line left keeps the name and the state.
  const line = page.getByRole("main").locator("header");
  await expect(line.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  await expect(line.getByRole("img", { name: "待機中" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "ヘッダーを表示" })).toBeVisible();
  await expect(page.getByText("mac · /work/gasho")).toBeHidden();
  await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await expect(page.getByText("mac · /work/gasho")).toBeVisible();
  await page.reload();
  await expect(page.getByText("mac · /work/gasho")).toBeVisible();
});

test("768px 未満では、セッションを開くたびにヘッダーが閉じた状態から始まる", async ({ page, hub, isMobile }) => {
  test.skip(!isMobile, "768px 未満の幅の動き");
  const daemon = await openSession(page, hub, {
    daemon: { sessions: [fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/other", name: "other-session" })] },
  });
  // The top bar has the name and the state while the header is closed.
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  await expect(page.getByText("mac · /work/gasho")).toBeHidden();
  await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await expect(page.getByText("mac · /work/gasho")).toBeVisible();

  await page.goto(sessionPath(daemon, OTHER_SESSION_ID));
  await expect(page.getByRole("heading", { name: "other-session" })).toBeVisible();
  await expect(page.getByText("mac · /work/other")).toBeHidden();
  await page.getByRole("button", { name: "ヘッダーを表示" }).click();
  await expect(page.getByText("mac · /work/other")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "other-session" })).toBeVisible();
  await expect(page.getByText("mac · /work/other")).toBeHidden();
});
