// The plugins screen (#/plugins, docs/plugins.md P9 and P10): where the catalog of GashoPlugins is read from and why it
// could not be, the installed plugins' cards and what they do, and adding a plugin of the catalog. The catalog and the
// plugins' releases come from the fake gh; the installed plugins are folders of e2e/plugins put in the Gasho server's
// plugins folder.
import fs from "node:fs";
import path from "node:path";
import {
  addPlugin,
  catalogAnswer,
  catalogWith,
  copyTestPlugin,
  type FakeAnswer,
  listedPlugin,
  pluginsDir,
  releasePlugin,
} from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { card, plugin, pluginStatus, sidebar } from "./plugin-helpers.ts";

const GENRES = [
  { id: "integration", name: "連携" },
  { id: "devtools", name: "開発ツール" },
  { id: "look", name: "見た目" },
];
const READ_CATALOG = ["release", "download", "catalog"];

test.describe("一覧の出どころ", () => {
  test.use({ hubOptions: { gh: catalogWith({ plugins: [listedPlugin({ id: "e2e-first", name: "E2E 最初" })] }) } });

  test("読んだリポジトリと時刻、読んでいるあいだと読めなかった理由を出し、つなぎ直すと読み直しを求める", async ({ page, hub }) => {
    // Every message the screen sends the Gasho server, on every connection.
    const sent: { type: string; refresh?: boolean }[] = [];
    const connections: { close: () => Promise<void> }[] = [];
    await page.routeWebSocket(/\/ws\/client$/, (ws) => {
      connections.push(ws);
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        sent.push(JSON.parse(String(m)) as { type: string; refresh?: boolean });
        server.send(m);
      });
    });
    await page.clock.install();
    await page.goto("/#/plugins");
    const main = page.getByRole("main");
    const reload = main.getByRole("button", { name: "再読み込み" });

    await test.step("Gasho サーバーが起動したときに読んだ一覧を出す", async () => {
      await expect(main.getByText("4rtofl/GashoPlugins の一覧（たった今確認）")).toBeVisible();
      await expect(card(main.getByRole("region", { name: "GashoPlugins にあるもの" }), "E2E 最初")).toBeVisible();
    });

    await test.step("「再読み込み」を押すと、読んでいるあいだはそう出して押せなくし、読んだ一覧に替える", async () => {
      const [catalog] = catalogWith({ plugins: [listedPlugin({ id: "e2e-first", name: "E2E 最初" }), listedPlugin({ id: "e2e-second", name: "E2E 二つめ" })] });
      await hub.gh.set({ answers: [{ ...catalog!, delayMs: 5_000 }] });
      await reload.click();
      await expect(main.getByText("4rtofl/GashoPlugins の一覧（読んでいます…）")).toBeVisible();
      await expect(reload).toBeDisabled();
      await expect(main.getByText("4rtofl/GashoPlugins の一覧（たった今確認）")).toBeVisible({ timeout: 30_000 });
      await expect(card(main, "E2E 二つめ")).toBeVisible();
      await expect(reload).toBeEnabled();
    });

    await test.step("gh が失敗すると理由を出し、前に読んだ一覧を出し続ける", async () => {
      const failures: [FakeAnswer, string][] = [
        [{ args: READ_CATALOG, stderr: "release not found\n", exitCode: 1 }, "4rtofl/GashoPlugins にカタログ（リリース catalog）がまだありません。"],
        [{ args: READ_CATALOG, stderr: "no assets match the file pattern\n", exitCode: 1 }, "リリースにファイルがありません。"],
        [{ args: READ_CATALOG, stderr: "To get started with GitHub CLI, please run:  gh auth login\n", exitCode: 4 }, "Gasho サーバーのマシンの gh が GitHub にログインしていません（gh auth login）。"],
        [{ args: READ_CATALOG, stderr: "HTTP 502: Bad Gateway (https://api.github.com/repos/4rtofl/GashoPlugins/releases)\n", exitCode: 1 }, "HTTP 502: Bad Gateway (https://api.github.com/repos/4rtofl/GashoPlugins/releases)"],
        [catalogAnswer({ catalog: "ではない" }), "catalog.json の形が正しくありません。"],
      ];
      for (const [answer, why] of failures) {
        await hub.gh.set({ answers: [answer] });
        await reload.click();
        await expect(main.getByText(`一覧を読めませんでした：${why}`)).toBeVisible({ timeout: 30_000 });
        await expect(main.getByText("4rtofl/GashoPlugins の一覧（たった今読んだもの）")).toBeVisible();
        await expect(card(main, "E2E 二つめ")).toBeVisible();
      }
    });

    await test.step("つなぎ直すと、画面が一覧の読み直しを求める", async () => {
      // Not "再読み込み", which asks with refresh.
      const asked = () => sent.filter((m) => m.type === "plugin.catalog.get" && !m.refresh).length;
      await expect.poll(asked).toBe(1);
      await connections[0]!.close();
      await expect.poll(() => connections.length, { timeout: 30_000 }).toBe(2);
      await expect.poll(asked, { timeout: 30_000 }).toBe(2);
    });

    await test.step("読んだ時刻は、時間がたつと「n分前」になる", async () => {
      await hub.gh.set({ answers: catalogWith({ plugins: [listedPlugin({ id: "e2e-first", name: "E2E 最初" })] }) });
      await reload.click();
      await expect(main.getByText("4rtofl/GashoPlugins の一覧（たった今確認）")).toBeVisible({ timeout: 30_000 });
      await page.clock.fastForward("03:00");
      // Intl.RelativeTimeFormat's words ("3 分前").
      await expect(main.getByText(/^4rtofl\/GashoPlugins の一覧（3\s?分前に確認）$/)).toBeVisible();
    });
  });
});

test.describe("入れたもの", () => {
  test.use({
    hubOptions: {
      gh: catalogWith({
        genres: GENRES,
        plugins: [
          listedPlugin({ id: "e2e-daemon", name: "E2E daemon", version: "1.1.0", genre: "integration", daemon: true }),
          listedPlugin({ id: "e2e-theme-a", name: "E2E 夜", version: "2.0.0", api: "1.99" }),
        ],
      }),
    },
  });

  test("カードに版・更新できる版・札・問題と注意・権限・working server ごとの状態を出す", async ({ page, hub }) => {
    await page.goto("/#/plugins");
    const installed = page.getByRole("region", { name: "入れたもの" });

    await test.step("何も入れていないときの文", async () => {
      await expect(installed.getByText("まだプラグインは入っていません。")).toBeVisible();
    });

    await addPlugin(hub, plugin("e2e-daemon"));
    await addPlugin(hub, plugin("e2e-theme-a"));
    await addPlugin(hub, plugin("e2e-theme-b"), { link: true });
    await addPlugin(hub, plugin("e2e-broken"), { link: true });
    const daemon = card(installed, "E2E daemon");
    const night = card(installed, "E2E 夜");
    const morning = card(installed, "E2E 朝");
    const broken = card(installed, "E2E 壊れた");

    await test.step("版、カタログの新しい版、ジャンル、権限を出す", async () => {
      await expect(daemon).toContainText("1.0.0");
      await expect(daemon.getByText("（1.1.0 に更新できる）")).toBeVisible();
      await expect(daemon.getByRole("button", { name: "更新" })).toBeVisible();
      await expect(daemon.getByText("連携", { exact: true })).toBeVisible();
      await expect(daemon.getByText("権限：セッションに発言を送る、セッションを起動する")).toBeVisible();
      await expect(daemon.getByText("開発中")).toHaveCount(0);
      // The catalog's new version needs an API this Gasho does not have: it cannot be updated to.
      await expect(night.getByText("（2.0.0 は API 1.99 が要る）")).toBeVisible();
      await expect(night.getByRole("button", { name: "更新" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "GashoPlugins にあるもの" }).getByText("ほかに入れられるプラグインはありません。")).toBeVisible();
    });

    await test.step("テーマの札・開発中の札・テーマが 2 つ以上有効なときの注意・読み込めない理由", async () => {
      await expect(night.getByText("テーマ", { exact: true })).toBeVisible();
      await expect(morning.getByText("開発中", { exact: true })).toBeVisible();
      // Linked plugins count as enabled until switched: two themes are enabled, and the first by id is used.
      await expect(morning.getByText("テーマが2つ以上有効です。当てているのは E2E 夜 です。使わないテーマを無効にしてください。")).toBeVisible();
      await expect(night.getByText(/テーマが2つ以上有効です/)).toHaveCount(0);
      await expect(broken.getByText("読み込めませんでした：読み込みで壊れました")).toBeVisible();
    });

    await test.step("サイドバーの「プラグイン」に、更新できるプラグインの数を出す", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: "プラグイン 1" })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("daemon の部分の、working server ごとの状態を出す", async () => {
      await expect(daemon.getByText("working server はまだ登録されていません。")).toBeVisible();
      const running = await hub.fakeDaemon({ name: "m-running" });
      pluginStatus(running, [{ id: "e2e-daemon", state: "running" }]);
      const starting = await hub.fakeDaemon({ name: "m-starting" });
      pluginStatus(starting, []);
      const off = await hub.fakeDaemon({ name: "m-off" });
      pluginStatus(off, [{ id: "e2e-daemon", state: "off" }]);
      // Says nothing of plugins: a gasho-daemon from before them.
      await hub.fakeDaemon({ name: "m-old" });
      const failed = await hub.fakeDaemon({ name: "m-failed" });
      pluginStatus(failed, [{ id: "e2e-daemon", state: "failed", error: "daemon.js の start が失敗しました" }]);
      const offline = await hub.fakeDaemon({ name: "m-offline" });
      await offline.disconnect();

      const states = daemon.getByRole("list", { name: "working server ごとの状態" });
      const expected = { "m-running": "動いている", "m-starting": "起動中", "m-off": "動かさない", "m-old": "gasho-daemon が古い", "m-failed": "失敗", "m-offline": "オフライン" };
      await expect(states.getByRole("listitem")).toHaveCount(Object.keys(expected).length);
      for (const [name, state] of Object.entries(expected)) {
        await expect(states.getByRole("listitem").filter({ hasText: name }).getByText(state, { exact: true })).toBeVisible();
      }
      await expect(daemon.getByText("m-failed：daemon.js の start が失敗しました")).toBeVisible();
    });
  });
});

test.describe("操作", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-parts")] } });

  test("「更新」でカタログの版に入れ替え、「設定」で設定の画面に移り、有効と無効を切り替え、外す", async ({ page, hub }) => {
    await addPlugin(hub, plugin("e2e-daemon"));
    const next = await copyTestPlugin(hub, "e2e-daemon", (m) => ({ ...m, version: "1.1.0" }));
    const release = await releasePlugin(hub, next, { delayMs: 3_000 });
    await hub.gh.set({ answers: catalogWith({ genres: GENRES, releases: [release] }) });
    await page.goto("/#/plugins");
    const main = page.getByRole("main");
    const installed = page.getByRole("region", { name: "入れたもの" });
    const daemon = card(installed, "E2E daemon");
    const parts = card(installed, "E2E 部品");
    await main.getByRole("button", { name: "再読み込み" }).click();

    await test.step("「更新」を押すと、カタログの版を取ってきて入れ替える", async () => {
      await expect(daemon.getByText("（1.1.0 に更新できる）")).toBeVisible({ timeout: 30_000 });
      await daemon.getByRole("button", { name: "更新" }).click();
      await expect(daemon.getByRole("button", { name: "更新しています…" })).toBeDisabled();
      await expect(daemon.getByText("1.1.0", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(daemon.getByText(/に更新できる/)).toHaveCount(0);
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: "プラグイン", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("有効を切ると部品が外れ、入れると戻る", async () => {
      const toggle = parts.getByRole("switch", { name: "E2E 部品 を有効にする" });
      await expect(toggle).toBeChecked();
      await expect((await sidebar(page)).getByRole("button", { name: /E2E メモ/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(parts.getByRole("button", { name: "設定" })).toHaveCount(0);
      await expect((await sidebar(page)).getByRole("button", { name: /E2E メモ/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect((await sidebar(page)).getByRole("button", { name: /E2E メモ/ })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("「設定」を押すと、設定の画面に移り、そのプラグインの欄がある", async () => {
      await parts.getByRole("button", { name: "設定" }).click();
      await expect(page).toHaveURL(/#\/settings$/);
      await expect(page.getByRole("region", { name: "E2E 部品" })).toBeVisible();
      await page.goBack();
    });

    await test.step("開発中のプラグインを外すと、リンクだけを消す", async () => {
      await parts.getByRole("button", { name: "E2E 部品 を外す" }).click();
      let dialog = page.getByRole("alertdialog", { name: "E2E 部品 を外しますか？" });
      await expect(dialog.getByText("Gasho サーバーに置いたリンクだけを消します。作っているプラグインのフォルダーは、そのまま残ります。")).toBeVisible();
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      await expect(dialog).toBeHidden();
      await expect(parts).toBeVisible();
      await parts.getByRole("button", { name: "E2E 部品 を外す" }).click();
      dialog = page.getByRole("alertdialog", { name: "E2E 部品 を外しますか？" });
      await dialog.getByRole("button", { name: "外す", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(parts).toHaveCount(0);
      expect(fs.existsSync(path.join(pluginsDir(hub), "e2e-parts"))).toBe(false);
      expect(fs.existsSync(path.join(plugin("e2e-parts"), "web.js"))).toBe(true);
    });

    await test.step("カタログから入れたプラグインを外すと、ファイルを消す", async () => {
      await daemon.getByRole("button", { name: "E2E daemon を外す" }).click();
      const dialog = page.getByRole("alertdialog", { name: "E2E daemon を外しますか？" });
      await expect(dialog.getByText("プラグインのファイルと、Gasho サーバーに保存したこのプラグインの設定を消します。開いている画面と gasho-daemon からも、すぐに外れます。")).toBeVisible();
      await expect(dialog.getByText("ブラウザーに覚えた設定は、それぞれのブラウザーに残ります。")).toBeVisible();
      await dialog.getByRole("button", { name: "外す", exact: true }).click();
      await expect(installed.getByText("まだプラグインは入っていません。")).toBeVisible();
      expect(fs.existsSync(path.join(pluginsDir(hub), "e2e-daemon"))).toBe(false);
      // Removed, it can be added again from the catalog.
      await expect(card(page.getByRole("region", { name: "GashoPlugins にあるもの" }), "E2E daemon")).toBeVisible();
    });
  });

  test("「設定」を押すと、設定の画面のそのプラグインの欄が見える位置で開く", async ({ page, browserName }) => {
    // In WebKit it scrolls there; in Chromium the scrolling comes before the settings screen is drawn.
    test.fail(browserName === "chromium", "#164: the button goes to the top of the settings screen");
    await page.goto("/#/plugins");
    await card(page.getByRole("region", { name: "入れたもの" }), "E2E 部品").getByRole("button", { name: "設定" }).click();
    await expect(page.getByRole("heading", { name: "E2E 部品" })).toBeInViewport();
  });
});

test.describe("GashoPlugins にあるもの", () => {
  // The first reading fails: no list has been read yet.
  test.use({ hubOptions: { gh: [{ args: READ_CATALOG, stderr: "HTTP 502: Bad Gateway\n", exitCode: 1 }] } });

  test("ジャンルごとに並べ、使えない API の理由を出し、追加のダイアログで入れる", async ({ page, hub }) => {
    await page.clock.install();
    await page.goto("/#/plugins");
    const main = page.getByRole("main");
    const available = page.getByRole("region", { name: "GashoPlugins にあるもの" });
    const installed = page.getByRole("region", { name: "入れたもの" });

    await test.step("一覧をまだ読めていないときと、読んでいるときの文", async () => {
      await expect(available.getByText("一覧をまだ読めていません。")).toBeVisible();
      await expect(main.getByText("一覧を読めませんでした：HTTP 502: Bad Gateway")).toBeVisible();
      const release = await releasePlugin(hub, plugin("e2e-daemon"), { delayMs: 3_000 });
      const [catalog, ...files] = catalogWith({
        genres: GENRES,
        releases: [release],
        plugins: [
          listedPlugin({ id: "e2e-tool", name: "E2E 道具", genre: "devtools", description: "道具の説明" }),
          listedPlugin({ id: "e2e-future", name: "E2E 新しい", genre: "devtools", api: "1.99" }),
          listedPlugin({ id: "e2e-other", name: "E2E ほか", genre: "unknown" }),
        ],
      });
      await hub.gh.set({
        answers: [
          { ...catalog!, delayMs: 5_000 },
          ...files,
          { args: ["release", "download", "e2e-tool-v1.0.0"], stderr: "release not found\n", exitCode: 1 },
          // Longer than the test waits: the screen gives up first (page.clock).
          { args: ["release", "download", "e2e-other-v1.0.0"], delayMs: 60_000 },
        ],
      });
      await main.getByRole("button", { name: "再読み込み" }).click();
      await expect(available.getByText("一覧を読んでいます…")).toBeVisible();
    });

    await test.step("ジャンルの順に見出しを付けて並べ、プラグインの無いジャンルは出さず、知らないジャンルは最後に出す", async () => {
      await expect(available.getByRole("heading", { level: 3 })).toHaveText(["連携", "開発ツール", "ジャンルなし"], { timeout: 30_000 });
      await expect(available.getByRole("group", { name: "連携" }).getByRole("listitem")).toHaveCount(1);
      await expect(available.getByRole("group", { name: "開発ツール" }).getByRole("listitem")).toHaveCount(2);
      await expect(card(available.getByRole("group", { name: "ジャンルなし" }), "E2E ほか")).toBeVisible();
    });

    await test.step("この Gasho が対応しない API のプラグインは、理由を出して「追加」を押せなくする", async () => {
      const future = card(available, "E2E 新しい");
      await expect(future.getByText("この Gasho では使えません（プラグインの API 1.99 が要ります）。")).toBeVisible();
      await expect(future.getByRole("button", { name: "追加" })).toBeDisabled();
      await expect(card(available, "E2E 道具").getByRole("button", { name: "追加" })).toBeEnabled();
    });

    await test.step("追加のダイアログは、すること・権限を出し、追加しているあいだは閉じられず、入れると閉じる", async () => {
      await card(available, "E2E daemon").getByRole("button", { name: "追加" }).click();
      const dialog = page.getByRole("dialog", { name: "E2E daemon を追加" });
      await expect(dialog.getByText("1.0.0　E2E テストで、daemon の部分の状態を出す")).toBeVisible();
      await expect(dialog.getByText("権限：セッションに発言を送る、セッションを起動する")).toBeVisible();
      await expect(dialog.getByText("追加すると、すぐに有効になります。プラグインは、Gasho の画面と同じ権限で動きます。")).toBeVisible();
      await expect(dialog.getByText("working server で動く部分は、すべての working server で動かします（あとから登録したものでも）。")).toBeVisible();
      await dialog.getByRole("button", { name: "追加して有効にする" }).click();
      await expect(dialog.getByRole("button", { name: "追加しています…" })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "やめる" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      const added = card(installed, "E2E daemon");
      await expect(added.getByRole("switch", { name: "E2E daemon を有効にする" })).toBeChecked();
      await expect(added.getByText("開発中")).toHaveCount(0);
      await expect(card(available, "E2E daemon")).toHaveCount(0);
    });

    await test.step("取ってこられなかったときは、ダイアログに理由を出す", async () => {
      await card(available, "E2E 道具").getByRole("button", { name: "追加" }).click();
      const dialog = page.getByRole("dialog", { name: "E2E 道具 を追加" });
      await expect(dialog.getByText("1.0.0　道具の説明")).toBeVisible();
      await dialog.getByRole("button", { name: "追加して有効にする" }).click();
      await expect(dialog.getByText("リリース e2e-tool-v1.0.0 が見つかりません。カタログを読み直してください。")).toBeVisible({ timeout: 30_000 });
      await dialog.getByRole("button", { name: "やめる" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("追加は 150 秒待って答えが無ければ諦める", async () => {
      await card(available, "E2E ほか").getByRole("button", { name: "追加" }).click();
      const dialog = page.getByRole("dialog", { name: "E2E ほか を追加" });
      await dialog.getByRole("button", { name: "追加して有効にする" }).click();
      await expect(dialog.getByRole("button", { name: "追加しています…" })).toBeDisabled();
      await page.clock.fastForward("02:29");
      await expect(dialog.getByRole("button", { name: "追加しています…" })).toBeDisabled();
      await page.clock.fastForward("00:02");
      await expect(dialog.getByText("応答がありませんでした。")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "追加して有効にする" })).toBeEnabled();
    });
  });
});
