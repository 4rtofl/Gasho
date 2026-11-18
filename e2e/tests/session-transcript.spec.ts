// The conversation of the session screen: how its entries are drawn, how it is read (a page at a time, from the newest),
// and where it is scrolled to.
import type { SentFiles } from "@gasho/protocol";
import { fakeSession, textEntry, transcriptPage } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import {
  chatBox,
  entry,
  gate,
  mediaAnswer,
  numberedEntries,
  OTHER_SESSION_ID,
  openSession,
  PNG,
  SESSION_ID,
  scrollConversation,
  sessionPath,
  toolCall,
  WEBM,
} from "./session-helpers.ts";

const ATTACHED = "/Users/e2e/.local/share/gasho/attachments/5d0c9a3e/20261118T101010-1-spec.pdf";

test("あなたの発言と添付の札、Claude の Markdown（生の HTML を出さず、リンクは新しいタブ、画像はリンク、表とコード）を描く", async ({ page, hub }) => {
  const markdown = [
    "# 調べた結果",
    "**太字** と [資料](https://example.com/doc) と ![構成図](https://example.com/arch.png) と [危ないリンク](javascript:void(0))",
    '<span data-e2e="raw">生の HTML</span>',
    "| 項目 | 値 |\n|---|---|\n| テスト | 129 件 |",
    "```ts\nconst answer = 42;\n```",
  ].join("\n\n");
  await openSession(page, hub, {
    transcript: [
      entry("user", [{ type: "text", text: `README を読んで\n@${ATTACHED}` }, { type: "image" }]),
      entry("assistant", [{ type: "text", text: markdown }]),
    ],
  });
  const conversation = page.locator(".chat-text");
  await expect(conversation.getByText("README を読んで", { exact: true })).toBeVisible();
  // A file sent from Gasho is a chip with its name, the path on hover; an image pasted into the terminal is a mark.
  await expect(conversation.getByText("spec.pdf", { exact: true })).toBeVisible();
  await expect(conversation.locator(`[title="${ATTACHED}"]`)).toBeVisible();
  await expect(conversation.getByText(ATTACHED)).toHaveCount(0);
  await expect(conversation.getByText("画像", { exact: true })).toBeVisible();

  await expect(conversation.getByRole("heading", { name: "調べた結果" })).toBeVisible();
  await expect(conversation.getByText("太字", { exact: true })).toHaveCSS("font-weight", "700");
  const link = conversation.getByRole("link", { name: "資料" });
  await expect(link).toHaveAttribute("href", "https://example.com/doc");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  // An image is a link to it: opening a conversation loads nothing from other servers.
  await expect(conversation.getByRole("link", { name: "画像：構成図" })).toHaveAttribute("href", "https://example.com/arch.png");
  await expect(page.locator('img[src="https://example.com/arch.png"]')).toHaveCount(0);
  await expect(conversation.getByText("危ないリンク")).toBeVisible();
  await expect(conversation.getByRole("link", { name: "危ないリンク" })).toHaveCount(0);
  await expect(conversation.getByText("生の HTML")).toBeVisible();
  await expect(conversation.locator("[data-e2e]")).toHaveCount(0);

  const table = conversation.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "項目" })).toBeVisible();
  await expect(table.getByRole("cell", { name: "129 件" })).toBeVisible();
  await expect(conversation.locator("pre")).toContainText("const answer = 42;");
});

test("ツールの呼び出しを折り畳み、続いた呼び出しを「ツール n 回」「エラー n 回」にまとめる", async ({ page, hub }) => {
  await openSession(page, hub, {
    transcript: [
      textEntry("user", "テストを流して"),
      ...toolCall("Read", { file_path: "/work/gasho/README.md" }, "中身です"),
      textEntry("assistant", "次に、テストとビルドを流します。"),
      ...toolCall("Bash", { command: "npm test" }, "テストが通りました"),
      ...toolCall("Bash", { command: "npm run build" }, "ビルドに失敗しました", true),
      ...toolCall("Read", { file_path: "/work/gasho/package.json" }, "{}"),
    ],
  });
  const conversation = page.locator(".chat-text");

  // One call: closed, with its tool and what it worked on; opened, its input and result.
  const read = conversation.locator("summary").filter({ hasText: "/work/gasho/README.md" });
  await expect(read).toContainText("Read");
  await expect(conversation.getByText("中身です")).toBeHidden();
  await read.click();
  await expect(conversation.getByText("結果（4 文字）")).toBeVisible();
  await expect(conversation.getByText("中身です")).toBeVisible();

  // Calls in a row: one fold, with how many, the latest call and how many failed.
  const group = conversation.locator("summary").filter({ hasText: "ツール 3 回" });
  await expect(group).toContainText("/work/gasho/package.json");
  await expect(group).toContainText("エラー 1 回");
  await expect(conversation.locator("summary").filter({ hasText: "npm test" })).toBeHidden();
  await group.click();
  await expect(conversation.locator("summary").filter({ hasText: "npm test" })).toBeVisible();
  const failed = conversation.locator("summary").filter({ hasText: "npm run build" });
  await expect(failed).toContainText("エラー");
  await failed.click();
  await expect(conversation.getByText("エラー（10 文字）")).toBeVisible();
  await expect(conversation.getByText("ビルドに失敗しました")).toBeVisible();
});

test("シェルのコマンド、会話の要約、割り込み、サブエージェント、Claude が送った画像・動画・ファイルを描く", async ({ page, hub }) => {
  const sendFiles = (id: string, sent: SentFiles) => entry("assistant", [{ type: "tool_use", id, name: "SendUserFile", input: "{}", sent }]);
  await openSession(page, hub, {
    setup: (daemon) =>
      daemon.handle("media.get", (msg) =>
        msg.path.endsWith("shot.png")
          ? mediaAnswer(msg, PNG, "image/png")
          : msg.path.endsWith("demo.webm")
            ? mediaAnswer(msg, WEBM, "video/webm")
            : { type: "media", requestId: msg.requestId, notFound: true },
      ),
    transcript: [
      textEntry("user", "<bash-input>ls</bash-input>"),
      textEntry("user", "<bash-stdout>README.md\npackage.json</bash-stdout><bash-stderr></bash-stderr>"),
      textEntry("user", "<bash-input>ls nope</bash-input>"),
      textEntry("user", "<bash-stdout></bash-stdout><bash-stderr>ls: nope: No such file or directory</bash-stderr>"),
      entry("system", [{ type: "text", text: "Conversation compacted" }], { compaction: "mark" }),
      entry("system", [{ type: "text", text: "これまでの要約: README を読んだ。" }], { compaction: "summary" }),
      entry("user", [{ type: "text", text: "[Request interrupted by user]" }], { interrupted: true }),
      entry("assistant", [{ type: "text", text: "サブエージェントの報告です。" }], { isSidechain: true }),
      sendFiles("toolu_send_1", {
        files: [
          { path: "/work/gasho/shot.png", kind: "image" },
          { path: "/work/gasho/notes.txt", kind: "file" },
        ],
        caption: "画面のスクリーンショットです。",
      }),
      sendFiles("toolu_send_2", { files: [{ path: "/work/gasho/demo.webm", kind: "video" }] }),
      sendFiles("toolu_send_3", { files: [{ path: "/work/gasho/gone.mp4", kind: "video" }] }),
    ],
  });
  const conversation = page.locator(".chat-text");

  // A shell command and what it printed, as in a terminal; what a failed one printed in red.
  const listed = conversation.locator("pre").filter({ hasText: "package.json" });
  await expect(listed).toContainText("README.md");
  await expect(conversation.getByLabel("シェルのコマンド")).toHaveCount(2);
  await expect(conversation.getByText("ls nope", { exact: true })).toBeVisible();
  await expect(conversation.getByText("ls: nope: No such file or directory")).toHaveClass(/text-red/);
  await expect(conversation.getByText("<bash-input>", { exact: false })).toHaveCount(0);

  // The summary is folded under its line.
  await expect(conversation.getByText("会話を要約しました")).toBeVisible();
  await expect(conversation.getByText("これまでの要約: README を読んだ。")).toBeHidden();
  await conversation.getByText("会話を要約しました").click();
  await expect(conversation.getByText("これまでの要約: README を読んだ。")).toBeVisible();

  await expect(conversation.getByText("割り込まれました")).toBeVisible();
  await expect(conversation.getByText("[Request interrupted by user]")).toHaveCount(0);
  await expect(conversation.getByText("サブエージェント", { exact: true })).toBeVisible();
  await expect(conversation.getByText("サブエージェントの報告です。")).toBeVisible();

  // The files Claude sent: an image read from the working server, other files by name, the caption.
  const sent = conversation.getByRole("group", { name: "Claude が送ったファイル" });
  const image = sent.first().getByRole("img", { name: "shot.png" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(1);
  await expect(sent.first().getByText("notes.txt")).toBeVisible();
  await expect(sent.first().getByText("画面のスクリーンショットです。")).toBeVisible();
  // A video plays in the conversation; one the working server does not have any more says so.
  const video = sent.nth(1).locator('video[aria-label="demo.webm"]');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v) => v.readyState)).toBeGreaterThanOrEqual(1);
  await expect(sent.nth(2).getByText("：表示できません（ファイルが消えたか、移された可能性があります）")).toBeVisible();
  await expect(sent.nth(2)).toContainText("gone.mp4");

  // Pressed, the image opens over the whole screen.
  await image.click();
  const viewer = page.getByRole("dialog", { name: "shot.png" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "閉じる" }).click();
  await expect(viewer).toBeHidden();
});

test("会話の読み込み中・まだ会話が無い・読み込めなかったときの文を出す", async ({ page, hub }) => {
  const EMPTY = "1c9e2d3f-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
  const answer = gate();
  const daemon = await hub.fakeDaemon({
    name: "mac",
    sessions: [
      fakeSession({ sessionId: SESSION_ID, cwd: "/work/gasho", name: "slow" }),
      fakeSession({ sessionId: OTHER_SESSION_ID, cwd: "/work/gasho", name: "broken" }),
      fakeSession({ sessionId: EMPTY, cwd: "/work/gasho", name: "new" }),
    ],
    transcripts: { [SESSION_ID]: [textEntry("assistant", "やっと読めました")] },
  });
  daemon.handle("transcript.get", async (msg) => {
    if (msg.sessionId === OTHER_SESSION_ID) {
      return { type: "transcript.page", requestId: msg.requestId, sessionId: msg.sessionId, entries: [], start: 0, total: 0, error: "会話のファイルを読めません" };
    }
    if (msg.sessionId === SESSION_ID) await answer.wait;
    return transcriptPage(daemon, msg);
  });

  await page.goto(sessionPath(daemon, SESSION_ID));
  await expect(page.getByText("読み込み中…")).toBeVisible();
  answer.open();
  await expect(page.getByText("やっと読めました")).toBeVisible();
  await expect(page.getByText("読み込み中…")).toHaveCount(0);

  await page.goto(sessionPath(daemon, OTHER_SESSION_ID));
  await expect(page.getByText("会話を読み込めませんでした：会話のファイルを読めません")).toBeVisible();

  await page.goto(sessionPath(daemon, EMPTY));
  await expect(page.getByText("まだ会話がありません")).toBeVisible();
});

test("上へスクロールすると前の会話を 80 件ずつ読み、読み込み中・失敗の文と「もう一度」を出す", async ({ page, hub }) => {
  const firstTry = gate();
  let older = 0;
  const daemon = await openSession(page, hub, {
    transcript: numberedEntries(200),
    setup: (daemon) =>
      daemon.handle("transcript.get", async (msg) => {
        if (msg.before !== undefined && ++older === 1) {
          await firstTry.wait;
          return { type: "transcript.page", requestId: msg.requestId, sessionId: msg.sessionId, entries: [], start: 0, total: 0, error: "時間切れ" };
        }
        return transcriptPage(daemon, msg);
      }),
  });
  // The newest page: the last 80 entries, from the bottom.
  await expect(page.getByText("発言 200", { exact: true })).toBeInViewport();
  await expect(page.getByText("発言 121", { exact: true })).toBeAttached();
  await expect(page.getByText("発言 120", { exact: true })).toHaveCount(0);

  await scrollConversation(page, "top");
  await expect(page.getByText("前の会話を読み込んでいます…")).toBeVisible();
  const asked = await daemon.waitFor("transcript.get", (m) => m.before !== undefined);
  expect(asked).toMatchObject({ before: 120, limit: 80 });
  firstTry.open();
  await expect(page.getByText("会話を読み込めませんでした：時間切れ")).toBeVisible();

  await page.getByRole("button", { name: "もう一度" }).click();
  await expect(page.getByText("発言 41", { exact: true })).toBeAttached();
  await expect(page.getByText("発言 40", { exact: true })).toHaveCount(0);
  // What was on screen stays there as the older entries are put above it.
  await expect(page.getByText("発言 121", { exact: true })).toBeInViewport();
  await expect(page.getByText("会話を読み込めませんでした：時間切れ")).toHaveCount(0);

  await scrollConversation(page, "top");
  await expect(page.getByText("発言 1", { exact: true })).toBeAttached();
  await expect(page.getByText("発言 41", { exact: true })).toBeInViewport();
  expect(daemon.received.filter((m) => m.type === "transcript.get").map((m) => m.before)).toEqual([undefined, 120, 120, 40]);
});

test("一番下にいないと「最新の発言へ」が出て、押すと下へ動く。新しい発言は一番下にいるときだけ追う", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, { transcript: numberedEntries(60) });
  const newest = page.getByRole("button", { name: "最新の発言へ" });
  await expect(page.getByText("発言 60", { exact: true })).toBeInViewport();
  await expect(newest).toHaveCount(0);

  // At the bottom, a new entry is followed.
  daemon.append(SESSION_ID, [textEntry("assistant", "発言 61")]);
  await expect(page.getByText("発言 61", { exact: true })).toBeInViewport();

  // Scrolled up, the conversation stays where the reader is.
  await scrollConversation(page, "top");
  await expect(newest).toBeVisible();
  await expect(page.getByText("発言 1", { exact: true })).toBeInViewport();
  daemon.append(SESSION_ID, [textEntry("assistant", "発言 62")]);
  await expect(page.getByText("発言 62", { exact: true })).toBeAttached();
  await expect(page.getByText("発言 1", { exact: true })).toBeInViewport();
  await expect(page.getByText("発言 62", { exact: true })).not.toBeInViewport();

  await newest.click();
  await expect(page.getByText("発言 62", { exact: true })).toBeInViewport();
  await expect(newest).toHaveCount(0);

  // A message sent from here is shown, wherever the conversation was scrolled to.
  await scrollConversation(page, "top");
  await expect(newest).toBeVisible();
  await chatBox(page).fill("上から送る");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.locator(".chat-text").getByText("上から送る")).toBeInViewport();
});

test("設定で選んだ文字の大きさが、会話の文字に出る", async ({ page, hub }) => {
  const daemon = await openSession(page, hub, { transcript: [textEntry("user", "大きさの見本"), textEntry("assistant", "返事の見本")] });
  const reply = page.locator(".chat-text").getByText("返事の見本");
  await expect(reply).toHaveCSS("font-size", "14px");

  await page.goto("/#/settings");
  await page.getByRole("button", { name: "大きくする" }).click();
  await page.getByRole("button", { name: "大きくする" }).click();
  await expect(page.getByText("16px")).toBeVisible();

  await page.goto(sessionPath(daemon));
  await expect(reply).toHaveCSS("font-size", "16px");
  await expect(page.locator(".chat-text").getByText("大きさの見本")).toHaveCSS("font-size", "16px");
  // Kept in this browser.
  await page.reload();
  await expect(reply).toHaveCSS("font-size", "16px");
});
