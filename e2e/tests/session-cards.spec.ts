// Above the chat box of a session: the cards of what Claude waits on (a permission, Claude's questions, a plan to
// approve), answered from here and passed on to gasho-daemon, and the list of the work Claude runs in the background.
import type { Page } from "@playwright/test";
import type { AskedQuestion, PermissionRequestInfo, SessionInfo } from "@gasho/protocol";
import { commandResult, type FakeDaemon, type FakeDaemonOptions, fakeSession, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";

const SESSION = "5c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5";

/** Opens a session of a fake daemon, waiting on what `session` says. */
async function openSession(page: Page, hub: GashoHub, session: Partial<SessionInfo>, daemon: FakeDaemonOptions = {}): Promise<FakeDaemon> {
  const d = await hub.fakeDaemon({
    name: "mac",
    ...daemon,
    sessions: [
      fakeSession({
        sessionId: SESSION,
        cwd: "/work/gasho",
        name: "e2e-session",
        worktree: { path: "/work/gasho", repo: "/work/gasho", branch: "main" },
        ...session,
      }),
    ],
  });
  await page.goto(`/#/s/${d.machineId}/${SESSION}`);
  await expect(chatBox(page)).toBeVisible();
  return d;
}

const chatBox = (page: Page) => page.getByPlaceholder("Agent への指示を入力…");

let requests = 0;
function request(o: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo {
  return { id: `perm-${++requests}`, toolName: "Bash", input: '{\n  "command": "npm test"\n}', summary: "npm test", at: Date.now(), ...o };
}

/** The answer gasho-daemon got to the request `id`. */
const answerTo = (d: FakeDaemon, id: string) => d.waitFor("permission.answer", (m) => m.permissionId === id);

test("権限の確認で「許可」「今後も許可」「拒否」を押すと、押した答えが daemon に届く", async ({ page, hub }) => {
  const first = request({ always: "Bash(npm test:*)" });
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [first] });

  await expect(page.getByText("権限の確認")).toBeVisible();
  await page.getByText("入力", { exact: true }).click();
  await expect(page.getByText('"command": "npm test"')).toBeVisible();
  await page.getByRole("button", { name: "許可", exact: true }).click();
  expect(await answerTo(daemon, first.id)).toMatchObject({ sessionId: SESSION, decision: "allow" });

  // Answered, the request leaves the session's list, and the next one is shown.
  const second = request({ always: "Bash(npm test:*)", summary: "npm test -- --watch" });
  daemon.updateSession(SESSION, { permissionRequests: [second] });
  await expect(page.getByText("npm test -- --watch")).toBeVisible();
  await page.getByRole("button", { name: "今後も許可（Bash(npm test:*)）" }).click();
  expect(await answerTo(daemon, second.id)).toMatchObject({ decision: "always" });

  // Without a rule that Claude Code suggests, there is no "from now on".
  const third = request({ toolName: "Write", summary: "README.md" });
  daemon.updateSession(SESSION, { permissionRequests: [third] });
  await expect(page.getByText("README.md")).toBeVisible();
  await expect(page.getByRole("button", { name: /今後も許可/ })).toHaveCount(0);
  await page.getByRole("button", { name: "拒否" }).click();
  expect(await answerTo(daemon, third.id)).toMatchObject({ decision: "deny" });

  daemon.updateSession(SESSION, { status: "busy", permissionRequests: [] });
  await expect(page.getByText("権限の確認")).toHaveCount(0);
});

const QUESTIONS: AskedQuestion[] = [
  {
    header: "DB",
    question: "どのデータベースを使いますか？",
    options: [
      { label: "SQLite", description: "ファイル 1 つで動く", preview: "CREATE TABLE sessions (...)" },
      { label: "Postgres", description: "別のサーバーが要る" },
    ],
  },
  { header: "機能", question: "どの機能から作りますか？", multiSelect: true, options: [{ label: "ログイン" }, { label: "検索" }, { label: "通知" }] },
  { header: "名前", question: "画面の名前は？", options: [{ label: "ホーム" }, { label: "ダッシュボード" }] },
];

test("質問のカードで、単一選択・複数選択・自分の言葉の答えを選び、全問に答えると送れて、15 秒たつとまた押せる", async ({ page, hub }) => {
  await page.clock.install();
  const asked = request({ toolName: "AskUserQuestion", summary: undefined, questions: QUESTIONS });
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [asked] });

  const answer = page.getByRole("button", { name: "回答する" });
  const db = page.getByRole("group", { name: /どのデータベース/ });
  const features = page.getByRole("group", { name: /どの機能から/ });
  const naming = page.getByRole("group", { name: /画面の名前/ });
  await expect(page.getByText("Claude からの質問")).toBeVisible();
  // Answered from here: no word of sending it as the next message.
  await expect(page.getByText(/答えを次の発言として/)).toHaveCount(0);
  await expect(answer).toBeDisabled();

  // One option of a question that takes one, with what to look at for it.
  await db.getByRole("radio", { name: /SQLite/ }).check();
  await expect(page.getByText("CREATE TABLE sessions (...)")).toBeVisible();
  await db.getByRole("radio", { name: /Postgres/ }).check();
  await expect(db.getByRole("radio", { name: /SQLite/ })).not.toBeChecked();
  await expect(page.getByText("CREATE TABLE sessions (...)")).toHaveCount(0);
  await db.getByRole("radio", { name: /SQLite/ }).check();

  // Any of a question that takes several.
  await expect(features.getByText("いくつでも選べます")).toBeVisible();
  await features.getByRole("checkbox", { name: "ログイン" }).check();
  await features.getByRole("checkbox", { name: "通知" }).check();
  await expect(answer).toBeDisabled();

  // "Other" chosen with nothing written is no answer yet.
  await naming.getByRole("radio", { name: "その他（自分の言葉で答える）" }).check();
  await expect(answer).toBeDisabled();
  // Writing one's own answer chooses it in place of the option.
  await naming.getByRole("radio", { name: "ホーム" }).check();
  await naming.getByRole("textbox", { name: "名前：自分の言葉で答える" }).fill("トップ");
  await expect(naming.getByRole("radio", { name: "ホーム" })).not.toBeChecked();
  await expect(naming.getByRole("radio", { name: "その他（自分の言葉で答える）" })).toBeChecked();

  await expect(answer).toBeEnabled();
  // Stopped, the page's clock moves only as the test moves it, not while an expect waits.
  await page.clock.pauseAt(Date.now() + 60_000);
  await answer.click();
  expect(await answerTo(daemon, asked.id)).toMatchObject({
    decision: "allow",
    answers: [{ picked: [0] }, { picked: [0, 2] }, { picked: [], text: "トップ" }],
  });
  await expect(page.getByText("送りました")).toBeVisible();
  await expect(answer).toBeDisabled();
  await expect(page.getByRole("button", { name: "答えずに止める" })).toBeDisabled();

  // Still there after a while (its dialog did not close): it can be answered again after 15 seconds, not before.
  await page.clock.fastForward("00:14");
  await expect(page.getByText("送りました")).toBeVisible();
  await expect(answer).toBeDisabled();
  await page.clock.fastForward("00:02");
  await expect(page.getByText("送りました")).toHaveCount(0);
  await expect(answer).toBeEnabled();
});

test("答えを次の発言として送る質問にはその説明が出て、「答えずに止める」で拒否が daemon に届く", async ({ page, hub }) => {
  const asked = request({ toolName: "AskUserQuestion", summary: undefined, questions: QUESTIONS.slice(0, 1), answerAsMessage: true });
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [asked] });

  await expect(page.getByText("この質問には、Gasho から直接は答えられません。答えると、端末の質問を閉じてから、答えを次の発言として Claude に送ります。")).toBeVisible();
  await page.getByRole("button", { name: "答えずに止める" }).click();
  const got = await answerTo(daemon, asked.id);
  expect(got).toMatchObject({ decision: "deny" });
  expect(got.answers).toBeUndefined();
});

test("計画のカードで、auto モード・その都度承認・直してほしいところ・止めるの答えが daemon に届く", async ({ page, hub }) => {
  const plan = (n: number) => request({ toolName: "ExitPlanMode", summary: undefined, plan: `## 計画 ${n}\n\n- テストを足す\n- 実装する` });
  const auto = plan(1);
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [auto] });

  await expect(page.getByText("Claude が計画を立てました。この計画で進めますか？")).toBeVisible();
  await expect(page.getByRole("heading", { name: "計画 1" })).toBeVisible();
  await page.getByRole("button", { name: "はい、auto モードで進める" }).click();
  expect(await answerTo(daemon, auto.id)).toMatchObject({ decision: "allow", mode: "auto" });

  const ask = plan(2);
  daemon.updateSession(SESSION, { permissionRequests: [ask] });
  await expect(page.getByRole("heading", { name: "計画 2" })).toBeVisible();
  await page.getByRole("button", { name: "はい、編集はその都度承認する" }).click();
  expect(await answerTo(daemon, ask.id)).toMatchObject({ decision: "allow", mode: "default" });

  const revise = plan(3);
  daemon.updateSession(SESSION, { permissionRequests: [revise] });
  await expect(page.getByRole("heading", { name: "計画 3" })).toBeVisible();
  await page.getByRole("button", { name: "直してほしいところを伝える" }).click();
  const feedback = page.getByRole("textbox", { name: "計画の直してほしいところ" });
  await expect(feedback).toBeFocused();
  await expect(page.getByRole("button", { name: "送る" })).toBeDisabled();
  // Back to the answers, nothing sent.
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(feedback).toHaveCount(0);
  await page.getByRole("button", { name: "直してほしいところを伝える" }).click();
  await feedback.fill("先にテストを書いてください");
  await page.getByRole("button", { name: "送る" }).click();
  expect(await answerTo(daemon, revise.id)).toMatchObject({ decision: "deny", message: "先にテストを書いてください" });

  const stop = plan(4);
  daemon.updateSession(SESSION, { permissionRequests: [stop] });
  await expect(page.getByRole("heading", { name: "計画 4" })).toBeVisible();
  await page.getByRole("button", { name: "止める", exact: true }).click();
  const stopped = await answerTo(daemon, stop.id);
  expect(stopped).toMatchObject({ decision: "deny" });
  expect(stopped.message).toBeUndefined();
  expect(daemon.received.filter((m) => m.type === "permission.answer")).toHaveLength(4);
});

test("質問と計画を渡せない古い daemon では、古い旨の文が出て、拒否しかできない", async ({ page, hub }) => {
  // Before the questions and the plan were passed on, gasho-daemon sent them as plain requests.
  const asked = request({ toolName: "AskUserQuestion", summary: undefined });
  const plan = request({ toolName: "ExitPlanMode", summary: undefined });
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [asked, plan] }, { version: "0.9.0" });

  await expect(page.getByText("この working server の gasho-daemon は古いため、Gasho からは答えられません。端末か公式アプリで答えてください。")).toHaveCount(2);
  await expect(page.getByText("計画の承認")).toBeVisible();
  await expect(page.getByRole("button", { name: /許可/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "回答する" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /auto モード/ })).toHaveCount(0);

  await page.getByRole("button", { name: "答えずに止める" }).click();
  expect(await answerTo(daemon, asked.id)).toMatchObject({ decision: "deny" });
  await page.getByRole("button", { name: "拒否" }).click();
  expect(await answerTo(daemon, plan.id)).toMatchObject({ decision: "deny" });
});

test("working server がオフラインになると、確認カードとバックグラウンドの一覧のボタンを押せない", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, {
    status: "waiting",
    permissionRequests: [
      request({ always: "Bash(npm test:*)" }),
      request({ toolName: "AskUserQuestion", summary: undefined, questions: QUESTIONS.slice(0, 1) }),
      request({ toolName: "ExitPlanMode", summary: undefined, plan: "## 計画" }),
    ],
    background: [
      { id: "b1", kind: "shell", title: "npm test", startedAt: Date.now() },
      { id: "b2", kind: "agent", title: "調べる", startedAt: Date.now() },
    ],
  });
  const buttons = [
    "許可",
    "今後も許可（Bash(npm test:*)）",
    "拒否",
    "回答する",
    "答えずに止める",
    "はい、auto モードで進める",
    "はい、編集はその都度承認する",
    "直してほしいところを伝える",
    "すべて止める",
  ].map((name) => page.getByRole("button", { name, exact: true }));
  await page.getByRole("radio", { name: /SQLite/ }).check();
  for (const b of buttons) await expect(b).toBeEnabled();

  await daemon.disconnect();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();
  for (const b of buttons) await expect(b).toBeDisabled();
  // The plan's "止める" and each task's.
  const stops = page.getByRole("button", { name: "止める", exact: true });
  await expect(stops).toHaveCount(3);
  for (const b of await stops.all()) await expect(b).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Postgres/ })).toBeDisabled();
});

test("計画の直してほしいところを書いている途中でオフラインになると、入力欄と「送る」「戻る」を押せない", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, { status: "waiting", permissionRequests: [request({ toolName: "ExitPlanMode", summary: undefined, plan: "## 計画" })] });
  await page.getByRole("button", { name: "直してほしいところを伝える" }).click();
  const feedback = page.getByRole("textbox", { name: "計画の直してほしいところ" });
  const controls = [feedback, page.getByRole("button", { name: "送る" }), page.getByRole("button", { name: "戻る" })];
  await feedback.fill("先にテストを書いてください");
  for (const c of controls) await expect(c).toBeEnabled();

  await daemon.disconnect();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();
  for (const c of controls) await expect(c).toBeDisabled();
});

test("確認カードが会話の欄より高くても、上の部分と入力欄が見え、下の部分はスクロールして見られる（#109）", async ({ page, hub }) => {
  // Short, as a phone on its side; the width stays the project's (a computer's, or an iPhone's).
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  const many: AskedQuestion[] = Array.from({ length: 4 }, (_, i) => ({ question: `質問 ${i + 1}`, options: [{ label: `はい ${i + 1}` }, { label: `いいえ ${i + 1}` }] }));
  await openSession(page, hub, {
    status: "waiting",
    permissionRequests: [
      request({ toolName: "AskUserQuestion", summary: undefined, questions: many }),
      request({ toolName: "ExitPlanMode", summary: undefined, plan: Array.from({ length: 30 }, (_, i) => `- 手順 ${i + 1}`).join("\n") }),
      request({ toolName: "Write", summary: "最後の確認" }),
    ],
  });

  await expect(page.getByText("Claude からの質問")).toBeInViewport();
  await expect(chatBox(page)).toBeInViewport();
  const last = page.getByRole("button", { name: "拒否" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(chatBox(page)).toBeInViewport();
});

test("バックグラウンドの一覧に、件数・種類ごとの行・経過時間が出て、1 件ずつか、すべてを止められる", async ({ page, hub }) => {
  await page.clock.install();
  // The page's clock stops here once the session is open: the times below are from it.
  const now = Date.now() + 60 * 60_000;
  const daemon = await openSession(page, hub, {
    status: "busy",
    background: [
      { id: "b1", kind: "shell", title: "テストを流す", command: "npm test", startedAt: now - 30_000 },
      { id: "b2", kind: "monitor", title: "tail -f hub.log", command: "tail -f hub.log", startedAt: now - 5 * 60_000 },
      { id: "b3", kind: "agent", title: "原因を調べる", startedAt: now - 65 * 60_000 },
      { id: "b4", kind: "workflow", title: "レビュー", startedAt: now - 2 * 86_400_000 },
    ],
  });
  await page.clock.pauseAt(now);

  const list = page.getByRole("region", { name: "バックグラウンドで実行中" });
  const row = (title: string) => list.getByRole("listitem").filter({ hasText: title });
  await expect(list.getByText("バックグラウンドで実行中（4）")).toBeVisible();
  await expect(page.getByRole("img", { name: "バックグラウンドで 4 件実行中" })).toBeVisible();
  const detail = (title: string, kind: string) => row(title).getByText(new RegExp(`^${kind} · `));
  await expect(detail("テストを流す", "シェル")).toHaveText("シェル · 30秒前から · npm test");
  // The command is not repeated when it is the title.
  await expect(detail("tail -f hub.log", "監視")).toHaveText("監視 · 5分前から");
  await expect(detail("原因を調べる", "サブエージェント")).toHaveText("サブエージェント · 1時間5分前から");
  await expect(detail("レビュー", "ワークフロー")).toHaveText("ワークフロー · 2日前から");
  await page.clock.fastForward("02:00");
  await expect(detail("テストを流す", "シェル")).toHaveText("シェル · 2分前から · npm test");
  await expect(detail("原因を調べる", "サブエージェント")).toHaveText("サブエージェント · 1時間7分前から");

  daemon.handle("session.stopTask", (m) => commandResult(m, { ok: true, warning: "Claude Code の一覧で見つからなかったので、止めたかは分かりません。" }));
  await row("原因を調べる").getByRole("button", { name: "止める" }).click();
  expect(await daemon.waitFor("session.stopTask")).toMatchObject({ sessionId: SESSION, taskId: "b3" });
  await expect(list.getByText("Claude Code の一覧で見つからなかったので、止めたかは分かりません。")).toBeVisible();

  daemon.handle("session.stopTask", (m) => commandResult(m));
  await list.getByRole("button", { name: "すべて止める" }).click();
  const all = await daemon.waitFor("session.stopTask", (m) => m.taskId === undefined);
  expect(all).toMatchObject({ sessionId: SESSION });

  // With one left, there is nothing to stop all of.
  daemon.updateSession(SESSION, { background: [{ id: "b1", kind: "shell", title: "テストを流す", command: "npm test", startedAt: now - 30_000 }] });
  await expect(list.getByText("バックグラウンドで実行中（1）")).toBeVisible();
  await expect(list.getByRole("button", { name: "すべて止める" })).toHaveCount(0);
  daemon.updateSession(SESSION, { status: "idle", background: undefined });
  await expect(list).toHaveCount(0);
});
