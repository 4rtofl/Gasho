// The same way with this checkout's gasho-daemon in place of the fake one: it starts the fake claude in a terminal of
// its own, types the instruction into its prompt box, and sends the conversation the fake writes to its transcript.
import { expect, test } from "./fixtures.ts";

test("本物の daemon: 画面から起動したセッションに送った指示が claude に届き、返事が画面に出る", async ({ page, hub }) => {
  // gasho-daemon reads the terminal's screen and `claude agents` every second or so.
  test.slow();
  await hub.startDaemon({ name: "real", folders: ["work/gasho"] });
  await hub.claude.set({ replies: [{ text: "README を読んで", reply: "README を読みました。" }] });

  await page.goto("/");
  await expect(page.getByText(/gasho-daemon \d/)).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "新しいセッション" }).click();
  await page.getByRole("button", { name: "起動する", exact: true }).click();

  await page.getByPlaceholder("Agent への指示を入力…").fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("README を読みました。")).toBeVisible({ timeout: 60_000 });
  const launched = (await hub.claude.calls()).filter((c) => c.args[0]?.startsWith("--remote-control="));
  expect(launched).toHaveLength(1);
  expect(launched[0]?.cwd).toBe(`${hub.home}/work/gasho`);
});
