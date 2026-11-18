// The screen's URLs (lib/route.ts): each opens its screen or panel, one of a wrong form opens the home screen, a link
// from before the git plugin opens its panel, and switching panels does not add to the back button's history.
import type { Page } from "@playwright/test";
import { type FakeDaemon, fakeSession } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { onPhone } from "./screen.ts";

const SESSION = "2c4e6a8b-1d3f-4a5c-9e7b-0f2d4c6e8a1b";

async function daemon(hub: { fakeDaemon: (o: object) => Promise<FakeDaemon> }): Promise<FakeDaemon> {
  return hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session", gitBranch: "main" })] });
}

/** Goes to a URL of the screen without loading the page again. */
const goHash = (page: Page, hash: string) => page.evaluate(`location.hash = ${JSON.stringify(hash)}`);

test("それぞれの URL で、その画面かパネルが出る", async ({ page, hub }) => {
  const d = await daemon(hub);
  const s = `#/s/${encodeURIComponent(d.machineId)}/${SESSION}`;
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const region = (name: string) => page.getByRole("region", { name, exact: true });
  const screens: [string, ReturnType<Page["getByText"]>][] = [
    ["#/", heading("ホーム")],
    ["#/devices", heading("端末")],
    ["#/devices/updates", heading("端末")],
    ["#/settings", heading("設定")],
    ["#/plugins", heading("プラグイン")],
    ["#/p/e2e-plugin/home", page.getByText("このプラグインは、Gasho サーバーに入っていません。")],
    [s, heading("e2e-session")],
    [`${s}/graph`, region("ブランチグラフ")],
    [`${s}/files`, region("ファイル")],
    [`${s}/files/src`, region("ファイル")],
    [`${s}/file/src/main.ts`, region("main.ts")],
    [`${s}/p/e2e-plugin/list?kind=issues`, region("e2e-plugin")],
    [`#/w/${encodeURIComponent(d.machineId)}/${encodeURIComponent("/work/other")}`, page.getByText("この worktree はサイドバーにありません。")],
  ];
  await page.goto("/");
  for (const [hash, shown] of screens) {
    await goHash(page, hash);
    await expect(shown, hash).toBeVisible();
  }
});

test("形の正しくない URL はホームになる", async ({ page, hub }) => {
  const d = await daemon(hub);
  const s = `#/s/${encodeURIComponent(d.machineId)}/${SESSION}`;
  const wrong = [
    `${s}/files/../etc`,
    `${s}/file/src/./main.ts`,
    `${s}/file/%2E%2E`,
    `${s}/file/src%2F..%2Fmain.ts`,
    `${s}/files/src//main`,
    `${s}/file/`,
    `${s}/p/Bad_Plugin/list`,
    "#/p/x/home",
    `#/w/${encodeURIComponent(d.machineId)}/${encodeURIComponent("/work/gasho")}/p/1bad/view`,
    `${s}/pull/0`,
    "#/nothing-here",
  ];
  await page.goto("/");
  for (const hash of wrong) {
    // From another screen, so that the home screen shows because of this URL.
    await goHash(page, "#/settings");
    await expect(page.getByRole("heading", { name: "設定", exact: true })).toBeVisible();
    await goHash(page, hash);
    await expect(page.getByRole("heading", { name: "ホーム", exact: true }), hash).toBeVisible();
  }
});

test("古い GitHub のリンクは git プラグインのパネルで開き、アドレスバーが書き換わる", async ({ page, hub }) => {
  const d = await daemon(hub);
  const s = `/#/s/${encodeURIComponent(d.machineId)}/${SESSION}`;
  const repo = encodeURIComponent("org/app");
  const links: [string, string][] = [
    [`${s}/issues`, `${s}/p/git/list?kind=issues`],
    [`${s}/pulls/${repo}`, `${s}/p/git/list?kind=pulls&repo=org%2Fapp`],
    [`${s}/issue/12`, `${s}/p/git/item?kind=issues&number=12`],
    [`${s}/pull/34/${repo}`, `${s}/p/git/item?kind=pulls&number=34&repo=org%2Fapp`],
  ];
  for (const [old, now] of links) {
    await page.goto(old);
    await expect(page).toHaveURL(`${hub.url}${now}`);
    // The git plugin is not on this Gasho server: its panel says so.
    await expect(page.getByRole("region", { name: "git", exact: true }).getByText("このプラグインは、Gasho サーバーに入っていません。")).toBeVisible();
  }
});

test("パネルを替えても、戻るボタンの履歴が増えない", async ({ page, hub }) => {
  test.skip(onPhone(page), "スマホの幅ではパネルがセッションの代わりに出て、セッションの見出しのボタンでパネルを替えられない");
  const d = await daemon(hub);
  const s = `/#/s/${encodeURIComponent(d.machineId)}/${SESSION}`;
  await page.goto(s);
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  const length = () => page.evaluate<number>("history.length");
  const start = await length();

  // Opening the first panel is a step back can undo; switching it is not.
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect(page.getByRole("region", { name: "ブランチグラフ" })).toBeVisible();
  expect(await length()).toBe(start + 1);
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await expect(page.getByRole("region", { name: "ファイル" })).toBeVisible();
  await page.getByRole("button", { name: "main", exact: true }).click();
  await expect(page.getByRole("region", { name: "ブランチグラフ" })).toBeVisible();
  expect(await length()).toBe(start + 1);

  await page.goBack();
  await expect(page).toHaveURL(`${hub.url}${s}`);
  await expect(page.getByRole("region", { name: "ブランチグラフ" })).toBeHidden();
});
