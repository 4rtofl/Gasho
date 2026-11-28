// How the screen loads a plugin's web part (docs/plugins.md, 画面での読み込み and P11): it gives up after 15 seconds;
// when a new version cannot be loaded, the version before goes on; and a part may send messages and start sessions
// only with the permissions of its gasho-plugin.json. The plugins are folders of e2e/plugins, the ones the test
// changes copied to the test's folder and linked as plugins being developed.
import fsp from "node:fs/promises";
import path from "node:path";
import type { PluginManifest } from "@gasho/protocol";
import { addPlugin, commandResult, copyTestPlugin, fakeSession, TEST_PLUGINS, writePlugin } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { card, plugin, sidebar } from "./plugin-helpers.ts";

test.describe("時間切れ", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-hang")] } });

  test("読み込みが 15 秒で終わらなければ諦めて、理由を出す", async ({ page }) => {
    // Paused: the clock would go on with real time, and a slow machine would pass 15 seconds before the test looks.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
    await page.goto("/#/p/e2e-hang/notes");
    const main = page.getByRole("main");

    await test.step("読み込んでいるあいだは、ページとプラグインの画面に「読み込み中…」を出す", async () => {
      await expect(main.getByText("読み込み中…")).toBeVisible();
      await page.goto("/#/plugins");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 終わらない").getByText("読み込み中…")).toBeVisible();
      await page.goto("/#/p/e2e-hang/notes");
    });

    await test.step("15 秒たつと諦める", async () => {
      await page.clock.fastForward("00:14");
      await expect(main.getByText("読み込み中…")).toBeVisible();
      await page.clock.fastForward("00:02");
      await expect(main.getByText("読み込めませんでした：web.js が15秒たっても読み込めませんでした。")).toBeVisible();
      await page.goto("/#/plugins");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 終わらない").getByText("読み込めませんでした：web.js が15秒たっても読み込めませんでした。")).toBeVisible();
    });
  });
});

test("新しい版を読み込めないときと、gasho-plugin.json に問題があるときは、前の版のまま動き、直した版に入れ替わる", async ({ page, hub }) => {
  const dir = await copyTestPlugin(hub, "e2e-reload");
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, "gasho-plugin.json"), "utf8")) as PluginManifest;
  const first = await fsp.readFile(path.join(TEST_PLUGINS, "e2e-reload", "web.js"), "utf8");
  await addPlugin(hub, dir, { link: true });
  await page.goto("/#/p/e2e-reload/page");
  const main = page.getByRole("main");
  const reload = card(page.getByRole("region", { name: "入れたもの" }), "E2E 入れ替え");
  await expect(main.getByText("1 つめの版")).toBeVisible();

  await test.step("読み込むときにエラーになる版に替わっても、前の版のまま動き、プラグインの画面に理由を出す", async () => {
    await writePlugin(dir, { files: { "web.js": 'throw new Error("2 つめの版は壊れています");\n' } });
    await page.goto("/#/plugins");
    await expect(reload.getByText("新しいバージョンを読み込めませんでした（前のバージョンのまま動いています）：2 つめの版は壊れています")).toBeVisible({ timeout: 30_000 });
    await expect((await sidebar(page)).getByRole("button", { name: "E2E 版 1" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/#/p/e2e-reload/page");
    await expect(main.getByText("1 つめの版")).toBeVisible();
  });

  await test.step("gasho-plugin.json に問題のある版は使わず、前の版のまま動き、理由を出す", async () => {
    await writePlugin(dir, { manifest: { ...manifest, web: { js: "missing.js" } } });
    await page.goto("/#/plugins");
    await expect(reload.getByText("新しい版に問題があります：web.js のファイル（missing.js）がありません。ビルドしましたか。")).toBeVisible({ timeout: 30_000 });
    await expect((await sidebar(page)).getByRole("button", { name: "E2E 版 1" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  await test.step("直した版は、ページを読み込み直さずに入れ替わる", async () => {
    await writePlugin(dir, { manifest, files: { "web.js": first.replaceAll("E2E 版 1", "E2E 版 3").replaceAll("1 つめの版", "3 つめの版") } });
    await expect((await sidebar(page)).getByRole("button", { name: "E2E 版 3" })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(reload.getByText(/読み込めませんでした|問題があります/)).toHaveCount(0);
    await page.goto("/#/p/e2e-reload/page");
    await expect(main.getByText("3 つめの版")).toBeVisible();
  });
});

test("gasho-plugin.json の permissions に書けば、プラグインから発言を送り、セッションを起動できる", async ({ page, hub }) => {
  const sessionId = "0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d10";
  const launched = "5d7c2e10-3b4a-4f6e-9a8b-1c2d3e4f5a6b";
  const d = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId, cwd: "/work/app", name: "作業" })] });
  d.handle("session.launch", (msg) => commandResult(msg, { ok: true, sessionId: launched }));
  const dir = await copyTestPlugin(hub, "e2e-parts", (m) => ({ ...m, permissions: ["session.input", "session.launch"] }));
  await addPlugin(hub, dir, { link: true });
  await page.goto(`/#/s/${encodeURIComponent(d.machineId)}/${sessionId}/p/e2e-parts/notes`);

  await test.step("発言を送る", async () => {
    await page.getByRole("button", { name: "続けてと送る" }).click();
    await expect(page.getByText("送りました")).toBeVisible();
    expect(await d.waitFor("session.input")).toMatchObject({ sessionId, text: "続けて", via: "e2e-parts" });
  });

  await test.step("セッションを起動する", async () => {
    await page.getByRole("button", { name: "起動する" }).click();
    await expect(page.getByText("起動しました")).toBeVisible();
    expect(await d.waitFor("session.launch")).toMatchObject({ cwd: "/work/app" });
  });
});

test("権限を宣言したプラグインでも Antigravity の起動とモデル・Effort を指定した発言は断られる", async ({ page, hub }) => {
  const sessionId = "antigravity-0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d10";
  const d = await hub.fakeDaemon({
    name: "ACP", sessions: [fakeSession({ sessionId, cwd: "/work/app", name: "作業", agent: "antigravity" })],
  });
  const dir = await copyTestPlugin(hub, "e2e-parts", (m) => ({ ...m, permissions: ["session.input", "session.launch"] }));
  await addPlugin(hub, dir, { link: true });
  await page.goto(`/#/s/${encodeURIComponent(d.machineId)}/${sessionId}/p/e2e-parts/notes?kind=antigravity`);
  const error = page.getByText(/Antigravity の起動、発言、権限への回答は Gasho の画面から/);
  await page.getByRole("button", { name: "起動する", exact: true }).click();
  await expect(error).toBeVisible();
  await page.getByRole("button", { name: "続けてと送る", exact: true }).click();
  await expect(page.getByText(/^送信：Antigravity の起動、発言、権限への回答は Gasho の画面から/)).toBeVisible();
  expect(d.received.filter((m) => m.type === "session.launch" || m.type === "session.input")).toHaveLength(0);
});
