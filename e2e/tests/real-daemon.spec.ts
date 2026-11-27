// The same way with this checkout's gasho-daemon in place of the fake one: it starts the fake claude in a terminal of
// its own, types the instruction into its prompt box, and sends the conversation the fake writes to its transcript.
import { chatBox, expect, test } from "./fixtures.ts";

test("本物の daemon: 画面から起動したセッションに送った指示が claude に届き、返事が画面に出る", async ({ page, hub }) => {
  // gasho-daemon reads the terminal's screen and `claude agents` every second or so.
  test.slow();
  await hub.startDaemon({ name: "real", folders: ["work/gasho"] });
  await hub.claude.set({ replies: [{ text: "README を読んで", reply: "README を読みました。" }] });

  await page.goto("/");
  await expect(page.getByText(/gasho-daemon \d/)).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "新しいセッション" }).click();
  await page.getByRole("button", { name: "起動する", exact: true }).click();

  await chatBox(page).fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("README を読みました。")).toBeVisible({ timeout: 60_000 });
  const launched = (await hub.claude.calls()).filter((c) => c.args[0]?.startsWith("--remote-control="));
  expect(launched).toHaveLength(1);
  expect(launched[0]?.cwd).toBe(`${hub.home}/work/gasho`);
});

test("本物の daemon: 起動したセッションは gasho のプラグインと worktree の hook つきで動き、「/」に gasho のスキルが出る", async ({ page, hub }) => {
  test.slow();
  await hub.startDaemon({ name: "real", folders: ["work/gasho"] });

  await page.goto("/");
  await expect(page.getByText(/gasho-daemon \d/)).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "新しいセッション" }).click();
  await page.getByRole("button", { name: "起動する", exact: true }).click();

  const input = chatBox(page);
  await expect(input).toBeVisible({ timeout: 60_000 });
  const launched = (await hub.claude.calls()).filter((c) => c.args[0]?.startsWith("--remote-control="));
  expect(launched).toHaveLength(1);
  const args = launched[0]?.args ?? [];
  expect(args[args.indexOf("--plugin-dir") + 1]).toMatch(/apps\/daemon\/claude-plugin$/);
  expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("gasho-daemon session launch");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Agent|Task|EnterWorktree");
  expect(settings.statusLine.command).toContain("statusline-relay");

  await input.fill("/gasho:");
  const menu = page.getByRole("listbox", { name: "スキル" });
  await expect(menu.getByRole("option", { name: /gasho:launch-gasho-session/ })).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByRole("option", { name: /gasho:remove-gasho-worktree/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /gasho:verify-in-chrome/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("gasho-skills.png") });
});
