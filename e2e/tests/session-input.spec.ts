// Through the whole way: a registered browser opens the home screen, opens a session of a working server, and sends it
// an instruction, which reaches gasho-daemon; the conversation gasho-daemon then sends is shown.
import { fakeSession, textEntry } from "../harness/index.ts";
import { chatBox, expect, test } from "./fixtures.ts";

test("ホームから開いたセッションに送った指示が daemon に届き、返した会話が画面に出る", async ({ page, hub }) => {
  const sessionId = "0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d10";
  const daemon = await hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId, cwd: "/work/gasho", name: "e2e-session", gitBranch: "main" })],
    transcripts: { [sessionId]: [textEntry("user", "こんにちは"), textEntry("assistant", "はい、どうぞ。")] },
  });

  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: /e2e-session/ }).click();
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  await expect(page.getByText("はい、どうぞ。")).toBeVisible();

  await chatBox(page).fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  const input = await daemon.waitFor("session.input");
  expect(input).toMatchObject({ sessionId, text: "README を読んで" });

  daemon.append(sessionId, [textEntry("user", "README を読んで"), textEntry("assistant", "README を読みました。")]);
  await expect(page.getByText("README を読みました。")).toBeVisible();
  // What was sent is shown once: the conversation's own entry takes the place of the one shown while it was sent.
  await expect(page.getByText("README を読んで", { exact: true })).toHaveCount(1);
});
