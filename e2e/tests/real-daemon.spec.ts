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

test("本物の daemon: 起動したセッションは gasho のプラグインと worktree の hook つきで動き、「/」に gasho のスキルが出る", async ({ page, hub }) => {
  test.slow();
  await hub.startDaemon({ name: "real", folders: ["work/gasho"] });

  await page.goto("/");
  await expect(page.getByText(/gasho-daemon \d/)).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "新しいセッション" }).click();
  await page.getByRole("button", { name: "起動する", exact: true }).click();

  const input = page.getByPlaceholder("Agent への指示を入力…");
  await expect(input).toBeVisible({ timeout: 60_000 });
  const launched = (await hub.claude.calls()).filter((c) => c.args[0]?.startsWith("--remote-control="));
  expect(launched).toHaveLength(1);
  const args = launched[0]?.args ?? [];
  expect(args[args.indexOf("--plugin-dir") + 1]).toMatch(/apps\/daemon\/claude-plugin$/);
  expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("gasho-daemon session launch");
  const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");
  expect(settings.hooks.PreToolUse[0].matcher).toBe("Agent|Task|EnterWorktree|Bash");
  expect(settings.statusLine.command).toContain("statusline-relay");

  await input.fill("/gasho:");
  const menu = page.getByRole("listbox", { name: "スキル" });
  await expect(menu.getByRole("option", { name: /gasho:launch-gasho-session/ })).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByRole("option", { name: /gasho:remove-gasho-worktree/ })).toBeVisible();
  await expect(menu.getByRole("option", { name: /gasho:verify-in-chrome/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("gasho-skills.png") });
});

test("Antigravity を画面から起動し、発言・送信待ち・権限への回答・割り込みを使える", async ({ page, hub }) => {
  await hub.startDaemon({ name: "ACP", folders: ["work/gasho"], antigravity: true });
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: "新しいセッション", exact: true }).click();
  const agent = page.getByRole("combobox", { name: "エージェント" });
  await agent.selectOption("antigravity");
  await page.getByLabel(/^名前/).fill("ACP 試験");
  await page.getByRole("button", { name: "起動する", exact: true }).click();

  const input = page.getByPlaceholder("Agent への指示を入力…");
  const send = async (text: string) => {
    await input.fill(text);
    await page.getByRole("button", { name: "送信", exact: true }).click();
  };
  await send("はじめの発言");
  await expect(page.getByText("偽 ACP の応答：はじめの発言", { exact: true })).toBeVisible();

  await send("権限を許可");
  const allow = page.getByRole("button", { name: "許可", exact: true });
  await expect(allow).toBeVisible();
  await send("待たせる発言");
  await expect(page.getByText("偽 ACP の応答：待たせる発言", { exact: true })).toHaveCount(0);
  await allow.click();
  await expect(page.getByText("偽 ACP の許可を受けました", { exact: true })).toBeVisible();
  await expect(page.getByText("偽 ACP の応答：待たせる発言", { exact: true })).toBeVisible();

  await send("権限を拒否");
  await page.getByRole("button", { name: "拒否", exact: true }).click();
  await expect(page.getByText("偽 ACP の拒否を受けました", { exact: true })).toBeVisible();

  await send("割り込み試験");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByText("割り込まれました", { exact: false })).toBeVisible();
});

test("Antigravity の未ログイン時は working server の端末でのログインを案内する", async ({ page, hub }) => {
  await hub.startDaemon({ name: "ACP", folders: ["work/gasho"], antigravity: true, env: { GASHO_TEST_ACP_MODE: "auth" } });
  await page.goto("/");
  await page.getByRole("main").getByRole("button", { name: "新しいセッション", exact: true }).click();
  await page.getByRole("combobox", { name: "エージェント" }).selectOption("antigravity");
  await page.getByRole("button", { name: "起動する", exact: true }).click();
  await expect(page.getByText("working server の端末で agy を起動してログインしてください。", { exact: true })).toBeVisible();
});
