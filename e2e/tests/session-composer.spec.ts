// The chat box of the session screen: what it sends to gasho-daemon and how, what it says about the session, and what
// it keeps.
import { devices, type Locator, type Page } from "@playwright/test";
import { commandResult, fakeSession, textEntry } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import {
  caretAt,
  chatBox,
  dataTransfer,
  gate,
  keydown,
  OTHER_SESSION_ID,
  openSession,
  paste,
  PNG,
  SESSION_ID,
  sessionPath,
} from "./session-helpers.ts";

const conversation = (page: Page) => page.locator(".chat-text");
const sendButton = (page: Page) => page.getByRole("button", { name: "送信", exact: true });
const attachments = (page: Page) => page.getByRole("list", { name: "添付ファイル" }).getByRole("listitem");
const MB = 1024 * 1024;

/** Where the caret of a text field is. */
const caret = (field: Locator): Promise<number> => field.evaluate((el) => el.selectionStart);

/** Picks files with the chat box's attach button. */
async function attach(page: Page, files: { name: string; size?: number }[]): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "ファイルを添付" }).click();
  await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: "text/plain", buffer: Buffer.alloc(f.size ?? 1, "a") })));
}

test("送った発言は「送信中…」から会話の発言に変わる。working server で待つと「送信待ち」になる", async ({ page, hub }) => {
  const answer = gate();
  const daemon = await openSession(page, hub);
  daemon.handle("session.input", async (msg) => {
    await answer.wait;
    return commandResult(msg);
  });
  await chatBox(page).fill("README を読んで");
  await sendButton(page).click();
  await expect(chatBox(page)).toHaveValue("");
  await expect(conversation(page).getByText("README を読んで")).toBeVisible();
  await expect(conversation(page).getByText("送信中…")).toBeVisible();
  answer.open();
  await daemon.waitFor("session.input");
  daemon.append(SESSION_ID, [textEntry("user", "README を読んで")]);
  await expect(conversation(page).getByText("送信中…")).toHaveCount(0);
  await expect(conversation(page).getByText("README を読んで", { exact: true })).toHaveCount(1);

  // The working server keeps it until the session has finished its work.
  daemon.handle("session.input", (msg) => commandResult(msg, { ok: true, queued: true }));
  await chatBox(page).fill("テストも流して");
  await sendButton(page).click();
  await expect(conversation(page).getByText("送信待ち（作業が終わったら送ります）")).toBeVisible();
  daemon.updateSession(SESSION_ID, { status: "busy", pendingInputs: 1 });
  await expect(page.getByText("送信待ち 1 件。作業が終わったら順に送ります。")).toBeVisible();
  daemon.updateSession(SESSION_ID, { status: "idle", pendingInputs: 0 });
  await expect(conversation(page).getByText("送信待ち（作業が終わったら送ります）")).toHaveCount(0);
  await expect(conversation(page).getByText("送信中…")).toBeVisible();
  daemon.append(SESSION_ID, [textEntry("user", "テストも流して")]);
  await expect(conversation(page).getByText("送信中…")).toHaveCount(0);
  await expect(page.getByText("送信待ち 1 件。作業が終わったら順に送ります。")).toHaveCount(0);
});

test("PC では Enter で送信・Shift+Enter で改行、タッチでは Enter で改行。⌘/Ctrl+Enter はどちらでも送信", async ({ page, hub, isMobile }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  await box.click();
  await page.keyboard.type("1 行目");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("2 行目");
  await expect(box).toHaveValue("1 行目\n2 行目");
  await page.keyboard.press("Enter");
  if (isMobile) {
    await expect(box).toHaveValue("1 行目\n2 行目\n");
    await page.keyboard.press("ControlOrMeta+Enter");
  }
  // What is sent is trimmed.
  expect(await daemon.waitFor("session.input")).toMatchObject({ sessionId: SESSION_ID, text: "1 行目\n2 行目" });
  await expect(box).toHaveValue("");

  await page.keyboard.type("3 行目");
  await page.keyboard.press("ControlOrMeta+Enter");
  await daemon.waitFor("session.input", (m) => m.text === "3 行目");
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(2);
});

test("↑/↓ で送った文を 30 件までさかのぼる。カーソルが先頭（↑）・末尾（↓）にあるときだけ", async ({ page, hub }) => {
  // 31 messages are sent and called back one by one.
  test.slow();
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  for (let i = 1; i <= 31; i++) {
    await box.fill(`メッセージ ${i}`);
    await box.press("ControlOrMeta+Enter");
    await expect(box).toHaveValue("");
  }
  await daemon.waitFor("session.input", (m) => m.text === "メッセージ 31");

  await box.fill("書きかけ");
  await caretAt(box, "end");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("書きかけ");
  await caretAt(box, "start");
  await box.press("ArrowUp");
  await expect(box).toHaveValue("メッセージ 31");
  // A text called back has the caret at its start, so that ↑ goes on further back.
  await expect.poll(() => caret(box)).toBe(0);
  // Back down to what was being written.
  await box.press("ArrowDown");
  await expect(box).toHaveValue("メッセージ 31");
  await caretAt(box, "end");
  await box.press("ArrowDown");
  await expect(box).toHaveValue("書きかけ");

  await caretAt(box, "start");
  for (let i = 31; i >= 2; i--) {
    await box.press("ArrowUp");
    await expect(box).toHaveValue(`メッセージ ${i}`);
    await expect.poll(() => caret(box)).toBe(0);
  }
  // The 31st message before is not kept.
  await box.press("ArrowUp");
  await expect(box).toHaveValue("メッセージ 2");
  await caretAt(box, "end");
  await box.press("ArrowDown");
  await expect(box).toHaveValue("メッセージ 3");
});

test("作業中は送信ボタンが「停止」になり、押すか Esc で止める", async ({ page, hub }) => {
  let interrupts = 0;
  const daemon = await openSession(page, hub, { session: { status: "busy" } });
  daemon.handle("session.interrupt", (msg) =>
    ++interrupts === 1 ? commandResult(msg, { ok: true, warning: "止められなかった作業があります" }) : commandResult(msg, { ok: false, error: "止められませんでした" }),
  );
  await expect(sendButton(page)).toHaveCount(0);
  const box = chatBox(page);
  await box.fill("止まって");
  // While Claude works, nothing is sent.
  await box.press("ControlOrMeta+Enter");

  await page.getByRole("button", { name: "停止" }).click();
  await daemon.waitFor("session.interrupt", (m) => m.sessionId === SESSION_ID);
  await expect(page.getByText("止められなかった作業があります")).toBeVisible();
  await box.press("Escape");
  await expect(page.getByText("止められませんでした")).toBeVisible();
  expect(interrupts).toBe(2);
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(0);
  await expect(box).toHaveValue("止まって");

  daemon.updateSession(SESSION_ID, { status: "idle" });
  await expect(sendButton(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "停止" })).toHaveCount(0);
});

test("「!」で始めるとシェルモードになる（札・枠・「実行」・添付できない）", async ({ page, hub }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  const shellMark = page.getByTitle("「!」で始まる入力は、Claude Code のシェルモードで、そのままシェルのコマンドとして実行します");
  const inAmberFrame = () => box.evaluate((el) => el.closest('[class*="ring-amber"]') !== null);

  await expect(shellMark).toHaveCount(0);
  expect(await inAmberFrame()).toBe(false);
  await box.fill("!");
  await expect(shellMark).toBeVisible();
  await expect(page.getByRole("textbox", { name: "シェルのコマンド" })).toBeVisible();
  expect(await inAmberFrame()).toBe(true);
  // Nothing to run yet, and a command carries no files.
  await expect(page.getByRole("button", { name: "実行" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "ファイルを添付" })).toBeDisabled();

  await box.fill("!ls");
  await page.getByRole("button", { name: "実行" }).click();
  expect(await daemon.waitFor("session.input")).toMatchObject({ text: "!ls" });
  // The command runs as long as the session works.
  daemon.updateSession(SESSION_ID, { status: "busy" });
  await expect(conversation(page).getByText("ls", { exact: true })).toBeVisible();
  await expect(conversation(page).getByText("実行中…")).toBeVisible();
  daemon.updateSession(SESSION_ID, { status: "idle" });

  // Files attached before the "!" was typed are not sent with the command.
  await box.fill("");
  await attach(page, [{ name: "notes.txt" }]);
  await expect(attachments(page)).toHaveCount(1);
  await box.fill("!pwd");
  await box.press("ControlOrMeta+Enter");
  await expect(page.getByText("シェルのコマンドには、ファイルを添付できません。添付を外してください。")).toBeVisible();
  await expect(box).toHaveValue("!pwd");
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(1);
});

test("「n/20000」で文字数を出し、20000 文字を超えると送れない。スマホでは上限に近づいたときだけ入力欄の中に出す", async ({ page, hub, isMobile }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  await box.fill("あいう");
  if (isMobile) {
    await expect(page.getByText("3/20000")).toHaveCount(0);
    await box.fill("あ".repeat(17_001));
    await expect(page.getByText("17001/20000")).toBeVisible();
  } else {
    await expect(page.getByText("3/20000")).toBeVisible();
    await box.fill("");
    await expect(page.getByText("0/20000")).toBeVisible();
  }

  await box.fill("あ".repeat(20_001));
  const count = page.getByText("20001/20000");
  await expect(count).toBeVisible();
  await expect(count).toHaveClass(/text-rose/);
  await expect(sendButton(page)).toBeDisabled();
  await box.press("ControlOrMeta+Enter");

  await box.fill("あ".repeat(20_000));
  await expect(page.getByText("20000/20000")).not.toHaveClass(/text-rose/);
  await sendButton(page).click();
  const input = await daemon.waitFor("session.input");
  expect(input.text).toHaveLength(20_000);
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(1);
});

test("ボタン・ドロップ・貼り付けで添付し、外すボタンで外して、ファイルを送る", async ({ page, hub }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  await attach(page, [{ name: "a.txt" }]);
  await expect(attachments(page)).toHaveCount(1);

  await box.dispatchEvent("drop", { dataTransfer: await dataTransfer(page, [{ name: "b.txt", type: "text/plain", text: "B" }]) });
  await expect(attachments(page).filter({ hasText: "b.txt" })).toBeVisible();
  await paste(box, await dataTransfer(page, [{ name: "c.txt", type: "text/plain", text: "C" }]));
  await expect(attachments(page).filter({ hasText: "c.txt" })).toBeVisible();
  await expect(attachments(page)).toHaveCount(3);

  await attachments(page).filter({ hasText: "b.txt" }).getByRole("button").click();
  await expect(attachments(page)).toHaveCount(2);
  await expect(attachments(page).filter({ hasText: "b.txt" })).toHaveCount(0);

  await box.fill("この 2 つを読んで");
  await sendButton(page).click();
  const input = await daemon.waitFor("session.input");
  expect(input).toMatchObject({ text: "この 2 つを読んで", files: [{ name: "a.txt", data: Buffer.from("a").toString("base64") }, { name: "c.txt", data: Buffer.from("C").toString("base64") }] });
  await expect(attachments(page)).toHaveCount(0);
  // The message being sent shows its files.
  await expect(conversation(page).getByText("c.txt")).toBeVisible();
});

test("添付は 5 個・1 個 10MB・合計 10MB まで。超えると文を出して添付しない・送らない", async ({ page, hub }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  const alert = page.getByRole("alert");

  await attach(page, [1, 2, 3, 4, 5, 6].map((n) => ({ name: `f${n}.txt` })));
  await expect(attachments(page)).toHaveCount(5);
  await expect(attachments(page).filter({ hasText: "f6.txt" })).toHaveCount(0);
  await expect(alert).toContainText("5");
  await expect(page.getByRole("button", { name: "ファイルを添付" })).toBeDisabled();
  for (let n = 1; n <= 5; n++) await attachments(page).filter({ hasText: `f${n}.txt` }).getByRole("button").click();
  await expect(attachments(page)).toHaveCount(0);

  await attach(page, [{ name: "big.txt", size: 10 * MB + 1 }]);
  await expect(alert).toContainText("big.txt");
  await expect(attachments(page)).toHaveCount(0);

  // Each under 10MB, more than 10MB in all.
  await attach(page, [
    { name: "half1.txt", size: 6 * MB },
    { name: "half2.txt", size: 6 * MB },
  ]);
  await expect(attachments(page)).toHaveCount(2);
  await box.fill("大きいファイル");
  await sendButton(page).click();
  await expect(page.getByText("添付できるのは、合わせて 10MB までです。")).toBeVisible();
  await expect(alert).toHaveText("送れませんでした。入力は欄に戻しました。");
  await expect(box).toHaveValue("大きいファイル");
  await expect(attachments(page)).toHaveCount(2);
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(0);
});

test("モデル（既定・「いま」の札）・Effort・Ultracode は、いまと違うものを選ぶと次に送るときに切り替わり、Effort（とそのメニューの Ultracode）には切り替わるまで琥珀色の点が付く", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, {
    session: { model: "Opus 5.5", effort: "medium", ultracode: false },
    daemon: {
      capabilities: {
        models: [
          { id: "default", name: "Sonnet 5.5" },
          { id: "opus", name: "Opus 5.5" },
          { id: "fable", name: "Fable 5.2" },
          { id: "sonnet", name: "Sonnet 5.5" },
          { id: "haiku", name: "Haiku 5.5" },
        ],
        modelsAt: Date.now(),
      },
    },
  });
  await page.getByRole("button", { name: "モデル：Opus 5.5（選び直す）" }).click();
  const models = page.getByRole("listbox", { name: "モデル" });
  await expect(models.getByRole("option", { name: /Opus 5\.5/ })).toContainText("いま");
  await expect(models.getByRole("option", { name: /既定（Sonnet 5\.5）/ })).not.toContainText("いま");
  await models.getByRole("option", { name: /既定（Sonnet 5\.5）/ }).click();
  await expect(page.getByRole("button", { name: "モデル：既定（Sonnet 5.5）（選び直す）" })).toBeVisible();

  // The amber dot on the button, while what is picked differs from what the session runs with.
  const dot = (button: Locator) => button.locator(".bg-amber-400");
  const effort = page.getByRole("button", { name: /^Effort：/ });
  await expect(dot(effort)).toHaveCount(0);
  await page.getByRole("button", { name: "Effort：Medium" }).click();
  await expect(page.getByRole("menuitemradio", { name: /Medium/ })).toContainText("いま");
  await page.getByRole("menuitemradio", { name: /High/ }).first().click();
  await expect(page.getByRole("button", { name: "Effort：High（送るときに切り替えます）" })).toBeVisible();
  await expect(dot(effort)).toBeVisible();

  // Ultracode is in the same menu, which stays open after it is turned over.
  await page.getByRole("button", { name: "Effort：High（送るときに切り替えます）" }).click();
  const ultracode = page.getByRole("menuitemcheckbox", { name: /Ultracode/ });
  await expect(ultracode).toHaveAttribute("aria-checked", "false");
  await ultracode.click();
  await expect(ultracode).toHaveAttribute("aria-checked", "true");
  await expect(ultracode).toContainText("送るときに切り替えます");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Effort：High・Ultracode オン（送るときに切り替えます）" })).toBeVisible();

  await chatBox(page).fill("切り替えて続けて");
  await sendButton(page).click();
  expect(await daemon.waitFor("session.input")).toMatchObject({ text: "切り替えて続けて", model: "default", effort: "high", ultracode: true });

  // Once the session runs with them, the dot goes.
  daemon.updateSession(SESSION_ID, { model: "Sonnet 5.5 (default)", effort: "high", ultracode: true });
  await expect(page.getByRole("button", { name: "Effort：High・Ultracode オン" })).toBeVisible();
  await expect(dot(effort)).toHaveCount(0);

  // What the working server could not switch is dropped, and the session keeps what it had.
  daemon.handle("session.input", (msg) =>
    commandResult(msg, { ok: true, unapplied: ["effort", "ultracode"], warning: "Effort と Ultracode を切り替えられませんでした" }),
  );
  await page.getByRole("button", { name: "Effort：High・Ultracode オン" }).click();
  await expect(ultracode).toContainText("いまオン");
  await ultracode.click();
  await expect(ultracode).toHaveAttribute("aria-checked", "false");
  await page.getByRole("menuitemradio", { name: /Max/ }).click();
  await expect(page.getByRole("button", { name: "Effort：Max（送るときに切り替えます）" })).toBeVisible();
  await expect(dot(effort)).toBeVisible();
  await chatBox(page).fill("もう一度");
  await sendButton(page).click();
  expect(await daemon.waitFor("session.input", (m) => m.text === "もう一度")).toMatchObject({ effort: "max", ultracode: false });
  await expect(page.getByText("Effort と Ultracode を切り替えられませんでした")).toBeVisible();
  await expect(page.getByRole("button", { name: "Effort：High・Ultracode オン" })).toBeVisible();
  await expect(dot(effort)).toHaveCount(0);
});

test("古い gasho-daemon では、モデル・Effort・Ultracode・添付のうち、できないものを出さない", async ({ page, hub }) => {
  // gasho-daemon older than 0.6 does not list what it can do: 0.5 switches the model and carries files, older ones neither.
  const old = await hub.fakeDaemon({ name: "old", version: "0.4.0", capabilities: { features: undefined }, sessions: [fakeSession({ sessionId: SESSION_ID, cwd: "/work/old", name: "old-session" })] });
  const v05 = await hub.fakeDaemon({ name: "v05", version: "0.5.0", capabilities: { features: undefined }, sessions: [fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/v05", name: "v05-session" })] });

  await page.goto(sessionPath(old, SESSION_ID));
  await expect(chatBox(page)).toBeEnabled();
  await expect(page.getByRole("button", { name: "ファイルを添付" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^モデル：/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Effort：/ })).toHaveCount(0);
  await expect(page.getByRole("menuitemcheckbox", { name: /Ultracode/ })).toHaveCount(0);
  // A file dropped on the box is not attached.
  await chatBox(page).dispatchEvent("drop", { dataTransfer: await dataTransfer(page, [{ name: "b.txt", type: "text/plain", text: "B" }]) });
  await expect(attachments(page)).toHaveCount(0);

  await page.goto(sessionPath(v05, OTHER_SESSION_ID));
  await expect(page.getByRole("button", { name: "ファイルを添付" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^モデル：/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Effort：/ })).toHaveCount(0);
  await expect(page.getByRole("menuitemcheckbox", { name: /Ultracode/ })).toHaveCount(0);
});

test("オフライン・送信待ち・Gasho で答えられない確認待ちのときは、その文を出す", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, { session: { status: "waiting", waitingFor: "input needed" } });
  await expect(page.getByText("確認を待っています。端末か公式アプリで答えてください。")).toBeVisible();
  // A permission Gasho can answer is shown as a card instead.
  daemon.updateSession(SESSION_ID, { permissionRequests: [{ id: "p1", toolName: "Bash", input: '{\n  "command": "npm test"\n}', summary: "npm test", at: Date.now() }] });
  await expect(page.getByText("確認を待っています。端末か公式アプリで答えてください。")).toHaveCount(0);

  daemon.updateSession(SESSION_ID, { status: "busy", waitingFor: undefined, permissionRequests: undefined, pendingInputs: 2 });
  await expect(page.getByText("送信待ち 2 件。作業が終わったら順に送ります。")).toBeVisible();

  await daemon.disconnect();
  await expect(page.getByText("working server がオフラインです。")).toBeVisible();
  await expect(chatBox(page)).toBeDisabled();
  // The state says so too: in the header on a computer, in the top bar on a phone.
  await expect(page.getByText("オフライン", { exact: true }).filter({ visible: true }).first()).toBeVisible();
});

test("送れなかったときは「送れませんでした。入力は欄に戻しました。」を出し、入力と添付を欄に戻す", async ({ page, hub }) => {
  const daemon = await openSession(page, hub);
  daemon.handle("session.input", (msg) => commandResult(msg, { ok: false, error: "端末に入力できませんでした" }));
  await chatBox(page).fill("失敗する指示");
  await attach(page, [{ name: "a.txt" }]);
  await sendButton(page).click();
  await expect(page.getByRole("alert")).toHaveText("送れませんでした。入力は欄に戻しました。");
  await expect(page.getByText("端末に入力できませんでした")).toBeVisible();
  await expect(chatBox(page)).toHaveValue("失敗する指示");
  await expect(attachments(page)).toHaveCount(1);
  await expect(conversation(page).getByText("失敗する指示")).toHaveCount(0);
});

test("書きかけ（文・添付・選んだもの）はセッションごとに残り、別のセッションへ移って戻っても残る", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, {
    daemon: { sessions: [fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/other", name: "other-session" })] },
  });
  await chatBox(page).fill("A の書きかけ");
  await attach(page, [{ name: "a.txt" }]);
  await page.getByRole("button", { name: /^Effort：/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Ultracode/ }).click();
  await page.keyboard.press("Escape");

  await page.goto(sessionPath(daemon, OTHER_SESSION_ID));
  await expect(page.getByRole("heading", { name: "other-session" })).toBeVisible();
  await expect(chatBox(page)).toHaveValue("");
  await expect(attachments(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Effort：/ })).not.toHaveAccessibleName(/Ultracode オン/);
  await chatBox(page).fill("B の書きかけ");

  await page.goto("/#/");
  await page.goto(sessionPath(daemon));
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  await expect(chatBox(page)).toHaveValue("A の書きかけ");
  await expect(attachments(page).filter({ hasText: "a.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Effort：/ })).toHaveAccessibleName(/Ultracode オン/);

  await page.goto(sessionPath(daemon, OTHER_SESSION_ID));
  await expect(chatBox(page)).toHaveValue("B の書きかけ");
});

test("日本語の変換中の Enter では送らない", async ({ page, hub, browserName }) => {
  const daemon = await openSession(page, hub);
  const box = chatBox(page);
  await box.click();
  if (browserName === "chromium") {
    // A composition as an input method makes one: Chromium marks the keys pressed meanwhile as composing.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await expect(box).toHaveValue("にほんご");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await cdp.send("Input.insertText", { text: "日本語" });
    await expect(box).toHaveValue(/日本語/);
    await box.fill("日本語");
  } else {
    // WebKit cannot be made to compose: the keydowns of a composition, as Chromium sends them and as Safari sends the
    // Enter that ends one (keyCode 229, no longer composing).
    await box.fill("日本語");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(await keydown(box, { key: "Enter", ...init })).toBe(false);
      expect(await keydown(box, { key: "Enter", ctrlKey: true, metaKey: true, ...init })).toBe(false);
    }
  }
  // The same keys, not composing, send.
  await box.press("ControlOrMeta+Enter");
  expect(await daemon.waitFor("session.input")).toMatchObject({ text: "日本語" });
  expect(daemon.received.filter((m) => m.type === "session.input")).toHaveLength(1);
});

test("添付のエラーと、添付を外すボタンの名前を日本語で出す（#108）", async ({ page, hub }) => {
  await openSession(page, hub);
  await attach(page, [1, 2, 3, 4, 5, 6].map((n) => ({ name: `f${n}.txt` })));
  await expect(page.getByRole("alert")).toHaveText("添付できるファイルは 5 個までです");
  await expect(page.getByRole("button", { name: "f1.txt を外す" })).toBeVisible();
  for (let n = 1; n <= 5; n++) await attachments(page).filter({ hasText: `f${n}.txt` }).getByRole("button").click();
  await attach(page, [{ name: "big.txt", size: 10 * MB + 1 }]);
  await expect(page.getByRole("alert")).toHaveText("big.txt は 10 MB を超えています");
});

test("添付できないセッションと、文字も載っている貼り付けでは、文字を貼り付ける（#108）", async ({ page, hub, browserName }) => {
  test.skip(browserName !== "chromium", "クリップボードに文字と画像を一緒に載せられるのは Chromium だけ");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const daemon = await openSession(page, hub);
  const old = await hub.fakeDaemon({ name: "old", version: "0.4.0", capabilities: { features: undefined }, sessions: [fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/old", name: "old-session" })] });
  // As Excel puts a cell on the clipboard: its text, and a picture of it.
  const copyTextAndImage = () =>
    page.evaluate(async (png) => {
      const w = globalThis as unknown as {
        navigator: { clipboard: { write(items: unknown[]): Promise<void> } };
        ClipboardItem: new (items: Record<string, Blob>) => unknown;
      };
      await w.navigator.clipboard.write([
        new w.ClipboardItem({ "text/plain": new Blob(["貼った文字"], { type: "text/plain" }), "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) }),
      ]);
    }, [...PNG]);

  for (const [d, id] of [[old, OTHER_SESSION_ID], [daemon, SESSION_ID]] as const) {
    await page.goto(sessionPath(d, id));
    await copyTextAndImage();
    await chatBox(page).click();
    await page.keyboard.press("ControlOrMeta+V");
    await expect(chatBox(page)).toHaveValue("貼った文字");
    await expect(attachments(page)).toHaveCount(0);
  }
});

test("Mac 以外の PC では、チャット欄で Ctrl+B を押すとサイドバーを開閉する", async ({ page, hub, isMobile }) => {
  test.skip(isMobile, "サイドバーは 768px 以上の幅で開閉する");
  // Desktop Chrome's User-Agent is that of Windows, where Ctrl+B does nothing in a text box.
  await openSession(page, hub);
  await expect(page.getByRole("button", { name: "サイドバーを畳む" })).toBeVisible();
  const box = chatBox(page);
  await box.fill("ab");
  await box.press("Control+B");
  await expect(page.getByRole("button", { name: "サイドバーを開く" })).toBeVisible();
  await expect(page.getByRole("button", { name: "サイドバーを畳む" })).toHaveCount(0);
  await box.press("Control+B");
  await expect(page.getByRole("button", { name: "サイドバーを畳む" })).toBeVisible();
});

test.describe("Mac の Chrome", () => {
  test.use({ userAgent: devices["Desktop Chrome"].userAgent.replace(/\([^)]*\)/, "(Macintosh; Intel Mac OS X 10_15_7)") });

  test("Mac では、チャット欄で Ctrl+B を押してもサイドバーを開閉しない（#108）", async ({ page, hub, isMobile }) => {
    test.skip(isMobile, "サイドバーは 768px 以上の幅で開閉する");
    await openSession(page, hub);
    await expect(page.getByRole("button", { name: "サイドバーを畳む" })).toBeVisible();
    const box = chatBox(page);
    await box.fill("ab");
    await box.press("Control+B");
    // Typed after it: by then the screen has done what Ctrl+B does.
    await box.press("x");
    await expect(box).toHaveValue(/x/);
    await expect(page.getByRole("button", { name: "サイドバーを畳む" })).toBeVisible();
    await expect(page.getByRole("button", { name: "サイドバーを開く" })).toHaveCount(0);
  });
});
