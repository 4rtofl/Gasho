// The 端末 screen's section for updates (apps/web/src/components/daemon-updates.tsx): the latest versions published,
// as the fake npm says them; the Gasho server's row, run from this clone, and as `service install` installs it
// (HubOptions.service) through a whole update, its trial and going back by itself; the working servers' rows, which
// fake daemons drive; and the sidebar's 更新 badge. Times shown relative to now are moved on with Playwright's clock.
import type { Locator, Page } from "@playwright/test";
import type { HubToDaemon } from "@gasho/protocol";
import { checkoutVersion, commandResult, fakeSession, HUB_PACKAGE, hubInstallAnswer, npmLatestAnswer } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";

const DAEMON_PACKAGE = "@4rtofl/gasho-daemon";
const DAEMON = checkoutVersion("daemon");
/** A version of gasho-daemon newer than any published (made up). */
const NEWER = "0.99.0";
/** A Gasho server's update gets through a restart, its trial, and a page connecting again. */
const AFTER_RESTART = { timeout: 90_000 };

function updates(page: Page): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Gasho サーバーと gasho-daemon の更新" }) });
}

function serverRow(page: Page): Locator {
  return updates(page).getByRole("listitem").filter({ has: page.getByText("Gasho サーバー", { exact: true }) });
}

function machineRow(page: Page, name: string): Locator {
  return updates(page).getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

const narrow = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

/** The sidebar's 端末 item; on an iPhone, the sidebar is a drawer, opened first. */
async function devicesItem(page: Page): Promise<Locator> {
  if (!narrow(page)) return page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^端末/ });
  await page.getByRole("button", { name: "Open navigation" }).click();
  return page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: /^端末/ });
}

/** Chooses the 端末 item, which opens the 端末 screen; on an iPhone, once the drawer has closed. */
async function openDevices(page: Page, item: Locator): Promise<void> {
  await item.click();
  if (narrow(page)) await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
}

/**
 * Moves the page's clock on by `ms` (after page.clock.install). Not clock.fastForward: after it, WebKit does not end
 * motion's animations (the sidebar's drawer stays open). The times shown follow at useNow's next tick (5 s).
 */
async function moveClock(page: Page, ms: number): Promise<void> {
  await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + ms);
}

/** What the page copies, recorded in place of the clipboard (a test cannot read WebKit's). */
async function recordCopies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Run in the page (e2e/ is type-checked without the DOM's types).
    const w = globalThis as unknown as { copied: string[]; navigator: object };
    w.copied = [];
    Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void w.copied.push(text) } });
  });
}

const copied = (page: Page) => page.evaluate(() => (globalThis as unknown as { copied: string[] }).copied);

/** Marks this page, to tell whether it was loaded again (the mark goes with it). */
const mark = (page: Page) => page.evaluate("window.e2eMark = true");
// undefined while the page is being loaded again (it has nothing to evaluate in), for expect.poll to ask again.
const marked = (page: Page) => page.evaluate("window.e2eMark === true").catch(() => undefined);

test.describe("公開されている最新のバージョンを調べない Gasho サーバー", () => {
  test.use({ hubOptions: { env: { GASHO_LATEST_CHECK: "off" } } });

  test("調べていないと出て、「今すぐ調べる」が無い", async ({ page, hub }) => {
    await page.goto("/#/devices");
    await expect(updates(page).getByText("この Gasho サーバーは、公開されている最新のバージョンを調べていません。")).toBeVisible();
    await expect(updates(page).getByRole("button", { name: "今すぐ調べる" })).toHaveCount(0);
    await expect(updates(page).getByText("登録された working server はありません。")).toBeVisible();
    expect(await hub.npm.calls()).toEqual([]);
  });
});

test.describe("公開されている最新のバージョンを調べられない Gasho サーバー", () => {
  test.use({
    hubOptions: {
      npm: [
        { args: ["view", DAEMON_PACKAGE, "version"], exitCode: 1, stderr: "npm error code ETIMEDOUT\nnpm error network request to https://npm.pkg.github.com/ failed" },
        { args: ["view", HUB_PACKAGE, "version"], exitCode: 1, stderr: "npm error code E404\nnpm error 404 Not Found - GET https://npm.pkg.github.com/@4rtofl%2fgasho-hub" },
      ],
    },
  });

  test("まだわからないと理由が出て、「今すぐ調べる」で調べ直すと、バージョンと調べた時刻が出る", async ({ page, hub }) => {
    await page.clock.install();
    await page.goto("/#/devices");
    const section = updates(page);

    await test.step("調べられないと、まだわからないと出て、その理由が出る", async () => {
      await expect(section.getByText("公開されている最新のバージョンは、まだわかりません。")).toBeVisible();
      await expect(section.getByText("最新の版を調べられませんでした：npm error code ETIMEDOUT")).toBeVisible();
      await expect(section.getByText("Gasho サーバーの版は、まだ公開されていません。")).toBeVisible();
    });
    const failedAt = Date.now();

    await test.step("「今すぐ調べる」を押すと、調べている途中と出る", async () => {
      await hub.npm.set({
        answers: [
          { ...npmLatestAnswer(DAEMON_PACKAGE, NEWER), delayMs: 3000 },
          { ...npmLatestAnswer(HUB_PACKAGE, NEWER), delayMs: 3000 },
        ],
      });
      // The Gasho server looks the versions up again no sooner than 15 s after the last time (apps/hub/src/latest.ts).
      await new Promise((r) => setTimeout(r, Math.max(0, 15_500 - (Date.now() - failedAt))));
      await section.getByRole("button", { name: "今すぐ調べる" }).click();
      await expect(section.getByText("公開されている最新のバージョンを調べています…")).toBeVisible();
      await expect(section.getByRole("button", { name: "今すぐ調べる" })).toBeDisabled();
    });

    await test.step("調べ終えると、公開されている最新のバージョンと、調べた時刻が出る", async () => {
      await expect(section.getByText(`公開されている最新のバージョン：Gasho サーバー ${NEWER}・gasho-daemon ${NEWER}（たった今に調べました）`)).toBeVisible();
      await expect(section.getByText("最新の版を調べられませんでした")).toHaveCount(0);
      await expect(section.getByRole("button", { name: "今すぐ調べる" })).toBeEnabled();
      await moveClock(page, 10 * 60_000);
      await expect(section.getByText("（10 分前に調べました）")).toBeVisible();
    });

    await test.step("clone から動かしている Gasho サーバーは、更新できない理由を出し、更新のボタンもバッジも出さない", async () => {
      const row = serverRow(page);
      await expect(row).toContainText(`${NEWER} が公開されています。`);
      await expect(row).toContainText(
        "リポジトリの clone から動かしているので、Gasho からは更新できません。git pull して画面をビルドし直し（npm run web:build）、Gasho サーバーを動かし直してください。",
      );
      await expect(row.getByRole("button")).toHaveCount(0);
      const item = await devicesItem(page);
      await expect(item).not.toContainText("更新");
      await openDevices(page, item);
    });
  });
});

test.describe("gasho-daemon を更新できる working server", () => {
  test.use({ hubOptions: { npm: [npmLatestAnswer(DAEMON_PACKAGE, NEWER), npmLatestAnswer(HUB_PACKAGE, checkoutVersion("hub"))] } });

  test("確認のダイアログから更新し、段階が出て、つなぎ直すと更新したと出て、前のバージョンに戻せる", async ({ page, hub }) => {
    const sessionId = "6f0c2a8e-3d1b-4b7a-9e55-2b9d6c1a7f30";
    const daemon = await hub.fakeDaemon({
      name: "mac",
      capabilities: { update: { canUpdate: true } },
      sessions: [
        fakeSession({
          sessionId,
          cwd: "/work/gasho",
          name: "e2e-session",
          pendingInputs: 2,
          permissionRequests: [
            { id: "toolu_e2e_1", toolName: "Bash", input: '{ "command": "npm test" }', summary: "npm test", at: Date.now() },
            // Read again from the session's screen after the restart: not counted.
            { id: "question:e2e", toolName: "AskUserQuestion", input: "{}", at: Date.now() },
          ],
        }),
      ],
    });
    await page.clock.install();
    await page.goto("/");
    const row = machineRow(page, "mac");

    await test.step("サイドバーの「端末」に「更新」のバッジが出る", async () => {
      const item = await devicesItem(page);
      await expect(item).toContainText("更新");
      await openDevices(page, item);
    });

    await test.step("working server の行に、更新できるバージョンとボタンが出る", async () => {
      await expect(row).toContainText(`gasho-daemon ${DAEMON}`);
      await expect(row).toContainText(`${NEWER} に更新できます。`);
      await row.getByRole("button", { name: `${NEWER} に更新` }).click();
    });

    const dialog = page.getByRole("alertdialog");
    await test.step("確認のダイアログに、取り込むこと、送るのを待っている入力と権限の確認の件数、変更のリンクが出る", async () => {
      await expect(dialog.getByRole("heading")).toHaveText(`「mac」の gasho-daemon を ${NEWER} に更新しますか？`);
      await expect(dialog).toContainText(`${NEWER} を取り込み、起動できることを確かめてから切り替えて、gasho-daemon を動かし直します。`);
      await expect(dialog).toContainText("送るのを待っている入力が 2 件あります。送り終えてから切り替えます。");
      await expect(dialog).toContainText("権限の確認を待っているものが 1 件あります。");
      await expect(dialog.getByRole("link", { name: `${DAEMON} からの変更を GitHub で見る` })).toHaveAttribute(
        "href",
        `https://github.com/4rtofl/Gasho/compare/daemon-v${DAEMON}...daemon-v${NEWER}`,
      );
    });

    await test.step("「更新する」で working server に daemon.update が届き、ダイアログが閉じる", async () => {
      await dialog.getByRole("button", { name: "更新する" }).click();
      expect(await daemon.waitFor("daemon.update")).toMatchObject({ version: NEWER });
      await expect(dialog).toBeHidden();
    });

    await test.step("更新の段階が順に出て、そのあいだは更新のボタンが出ない", async () => {
      const steps = [
        ["install", "新しいバージョンを取り込んでいます"],
        ["check", "起動できるか確かめています"],
        ["wait", "送るのを待っている入力を、送り終えるまで待っています"],
        ["restart", "切り替えて、動かし直しています"],
      ] as const;
      for (const [step, label] of steps) {
        daemon.setCapabilities({ update: { canUpdate: true, progress: { version: NEWER, step, at: Date.now() } } });
        await expect(row).toContainText(`${NEWER} に更新しています：${label}`);
        await expect(row.getByRole("button", { name: `${NEWER} に更新` })).toHaveCount(0);
      }
    });

    await test.step("動かし直すあいだにつながらないまま 2 分を超えると、ログを見るよう出る", async () => {
      await daemon.disconnect();
      const slow = row.getByText("動かし直してから2分以上たっても、つながりません。");
      await expect(row).toContainText(`${NEWER} に更新しています：切り替えて、動かし直しています`);
      await expect(slow).toHaveCount(0);
      await moveClock(page, 121_000);
      await expect(slow).toBeVisible();
    });

    const updated = await test.step("新しいバージョンでつながると、更新したと出て、前のバージョンに戻すボタンが出る", async () => {
      const d = await daemon.startAgain({ version: NEWER, capabilities: { update: { canUpdate: true, previous: DAEMON, installed: [DAEMON] } } });
      await expect(row).toContainText(`gasho-daemon ${NEWER}`);
      await expect(row).toContainText(`${NEWER} に更新しました。`);
      await expect(row.getByRole("button", { name: `${DAEMON} に戻す` })).toBeVisible();
      return d;
    });

    await test.step("更新できるものが無くなると、バッジが消える", async () => {
      const item = await devicesItem(page);
      await expect(item).not.toContainText("更新");
      await openDevices(page, item);
    });

    await test.step("「前のバージョンに戻す」は、入っているバージョンへ切り替えると確かめてから送る", async () => {
      await row.getByRole("button", { name: `${DAEMON} に戻す` }).click();
      await expect(dialog.getByRole("heading")).toHaveText(`「mac」の gasho-daemon を ${DAEMON} に戻しますか？`);
      await expect(dialog).toContainText(`入っている ${DAEMON} に切り替えて、gasho-daemon を動かし直します。`);
      await expect(dialog.getByRole("link")).toHaveCount(0);
      await dialog.getByRole("button", { name: "戻す", exact: true }).click();
      expect(await updated.waitFor("daemon.update")).toMatchObject({ version: DAEMON });
      await expect(dialog).toBeHidden();
    });
  });
});

test.describe("gasho-daemon を更新できない working server", () => {
  test.use({ hubOptions: { npm: [npmLatestAnswer(DAEMON_PACKAGE, NEWER), npmLatestAnswer(HUB_PACKAGE, checkoutVersion("hub"))] } });

  test("古い・名前が変わる前・前の更新に失敗した・オフラインの working server が、それぞれの理由を出す", async ({ page, hub }) => {
    await recordCopies(page);
    // From before updates from Gasho: it says nothing about them.
    await hub.fakeDaemon({ name: "old" });
    await hub.fakeDaemon({ name: "renamed", version: "0.21.1", capabilities: { update: { canUpdate: true } } });
    const failing = await hub.fakeDaemon({
      name: "failing",
      capabilities: {
        update: { canUpdate: true, failed: { version: NEWER, error: `npm で ${DAEMON_PACKAGE}@${NEWER} を入れられませんでした：npm error 404 Not Found`, at: Date.now() } },
      },
    });
    failing.handle("daemon.update", (msg) => commandResult(msg, { ok: false, error: "gasho-daemon は別の更新の途中です。" }));
    const offline = await hub.fakeDaemon({ name: "offline", capabilities: { update: { canUpdate: true } } });
    await offline.disconnect();
    await page.clock.install();
    await page.goto("/#/devices");

    await test.step("古い gasho-daemon は、Gasho から更新できるようにするコマンドを出し、押すとコピーする", async () => {
      const row = machineRow(page, "old");
      await expect(row).toContainText("このバージョンの gasho-daemon は、Gasho からは更新できません。");
      await row.getByRole("button", { name: "npx @4rtofl/gasho-daemon@latest service install" }).click();
      await expect.poll(() => copied(page)).toEqual(["npx @4rtofl/gasho-daemon@latest service install"]);
    });

    await test.step("パッケージの名前が変わる前のバージョンは、公開されているバージョンと、理由とコマンドを出す", async () => {
      const row = machineRow(page, "renamed");
      await expect(row).toContainText(`${NEWER} が公開されています。`);
      await expect(row).toContainText("この working server の gasho-daemon は、パッケージの名前が変わる前の版のため、Gasho からは更新できません。");
      await expect(row.getByRole("button", { name: "npx @4rtofl/gasho-daemon@latest service install" })).toBeVisible();
      await expect(row.getByRole("button", { name: `${NEWER} に更新` })).toHaveCount(0);
    });

    const failed = machineRow(page, "failing");
    await test.step("前の更新に失敗した working server は、失敗したバージョンと理由と時刻を出し、もう一度更新できる", async () => {
      await expect(failed).toContainText(
        `${NEWER} への更新に失敗しました（たった今）。何も変えていません。npm で ${DAEMON_PACKAGE}@${NEWER} を入れられませんでした：npm error 404 Not Found`,
      );
      await expect(failed.getByRole("button", { name: `${NEWER} に更新` })).toBeVisible();
    });

    await test.step("更新の命令が断られると、ダイアログに理由が出て、閉じない", async () => {
      await failed.getByRole("button", { name: `${NEWER} に更新` }).click();
      const dialog = page.getByRole("alertdialog");
      await dialog.getByRole("button", { name: "更新する" }).click();
      await expect(dialog).toContainText("gasho-daemon は別の更新の途中です。");
      await expect(dialog.getByRole("button", { name: "更新する" })).toBeEnabled();
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("オフラインの working server は、最後に接続した時刻を出し、更新のボタンを出さない", async () => {
      const row = machineRow(page, "offline");
      await expect(row).toContainText("オフライン・最後の接続 たった今");
      await expect(row.getByRole("button")).toHaveCount(0);
    });

    await test.step("時計を進めると、失敗した時刻と最後に接続した時刻が変わる", async () => {
      await moveClock(page, 10 * 60_000);
      await expect(machineRow(page, "offline")).toContainText("オフライン・最後の接続 10 分前");
      await expect(failed).toContainText(`${NEWER} への更新に失敗しました（10 分前）。`);
    });
  });
});

test.describe("Gasho から更新できる Gasho サーバー", () => {
  test.use({
    hubOptions: {
      service: { version: "0.90.0" },
      npm: [npmLatestAnswer(DAEMON_PACKAGE, NEWER), npmLatestAnswer(HUB_PACKAGE, "0.90.1")],
      env: { GASHO_HUB_PROBATION_MS: "3000" },
    },
  });

  test("確認のダイアログから更新し、失敗・段階・命令を断ること・起動し直しを経て新しいバージョンで動き、前のバージョンに戻せる", async ({ page, hub }) => {
    test.slow();
    const service = hub.service;
    if (!service) throw new Error("the Gasho server does not run as a service");
    const sessionId = "1d7e4f60-8b2c-4a3e-b0f9-5c6a2e8d9b14";
    // From before updates from Gasho, until it says it can be updated: the badge is the Gasho server's alone.
    const daemon = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId, cwd: "/work/gasho", name: "e2e-session" })] });
    const latest = (await hub.npm.table()).answers ?? [];
    const install = await hubInstallAnswer("0.90.1");
    await page.clock.install();
    await page.goto("/");
    const row = serverRow(page);
    const dialog = page.getByRole("alertdialog");

    await test.step("サイドバーの「端末」に、Gasho サーバーの更新で「更新」のバッジが出る", async () => {
      const item = await devicesItem(page);
      await expect(item).toContainText("更新");
      await openDevices(page, item);
    });

    await test.step("Gasho サーバーの行に、動いているバージョンと、更新できるバージョンとボタンが出る", async () => {
      await expect(row).toContainText("gasho-hub 0.90.0");
      await expect(row).toContainText("0.90.1 に更新できます。");
      await expect(row.getByRole("button", { name: "0.90.1 に更新" })).toBeVisible();
    });

    await test.step("確認のダイアログに、取り込んで確かめることと、変更のリンクが出る", async () => {
      await row.getByRole("button", { name: "0.90.1 に更新" }).click();
      await expect(dialog.getByRole("heading")).toHaveText("Gasho サーバーを 0.90.1 に更新しますか？");
      await expect(dialog).toContainText(
        "0.90.1 を取り込み、起動できるかと、データベースを開けるか（写しで）を確かめてから切り替えて、Gasho サーバーを起動し直します。",
      );
      await expect(dialog).toContainText("新しいバージョンがうまく起動しなかったとき（1分のうちに止まったとき）は、自動で前のバージョンに戻します。");
      await expect(dialog.getByRole("link", { name: "0.90.0 からの変更を GitHub で見る" })).toHaveAttribute(
        "href",
        "https://github.com/4rtofl/Gasho/compare/hub-v0.90.0...hub-v0.90.1",
      );
    });

    await test.step("取り込めないと、失敗したと理由が出て、何も変えずに、もう一度更新できる", async () => {
      await hub.npm.set({ answers: [...latest, { args: install.args, exitCode: 1, stderr: "npm error code E404\nnpm error 404 Not Found - GET https://npm.pkg.github.com/@4rtofl%2fgasho-hub" }] });
      await dialog.getByRole("button", { name: "更新する" }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toContainText("0.90.1 への更新に失敗しました（たった今）。何も変えていません。npm で @4rtofl/gasho-hub@0.90.1 を入れられませんでした：");
      await expect(row).toContainText("gasho-hub 0.90.0");
      await expect(row.getByRole("button", { name: "0.90.1 に更新" })).toBeVisible();
    });

    let held: Extract<HubToDaemon, { type: "session.input" }> | undefined;
    await test.step("（用意）working server が答えない入力を 1 件送っておく", async () => {
      daemon.handle("session.input", (msg) => {
        held = msg;
        return undefined;
      });
      await page.goto(`/#/s/${encodeURIComponent(daemon.machineId)}/${sessionId}`);
      await page.getByPlaceholder("Agent への指示を入力…").fill("README を読んで");
      await page.getByRole("button", { name: "送信" }).click();
      await daemon.waitFor("session.input");
      await page.goto("/#/devices");
    });

    await test.step("取り込みと確かめのあと、処理中の命令が終わるのを待つ", async () => {
      await hub.npm.set({ answers: [...latest, { ...install, delayMs: 2000 }] });
      await row.getByRole("button", { name: "0.90.1 に更新" }).click();
      await dialog.getByRole("button", { name: "更新する" }).click();
      await expect(row).toContainText("0.90.1 に更新しています：新しいバージョンを取り込んでいます");
      await expect(row).toContainText("0.90.1 に更新しています：処理中の命令が終わるのを待っています", { timeout: 60_000 });
      await expect(row.getByText(/への更新に失敗しました/)).toHaveCount(0);
    });

    await test.step("処理中の命令を待つあいだ、ほかの命令は断られる", async () => {
      daemon.setCapabilities({ update: { canUpdate: true } });
      const mac = machineRow(page, "mac");
      await mac.getByRole("button", { name: `${NEWER} に更新` }).click();
      await dialog.getByRole("button", { name: "更新する" }).click();
      await expect(dialog).toContainText("Gasho サーバーを更新しています。起動し直したら、もう一度試してください。");
      await dialog.getByRole("button", { name: "キャンセル" }).click();
      expect(daemon.received.filter((m) => m.type === "daemon.update")).toEqual([]);
    });

    await test.step("命令が終わると切り替えて起動し直し、つながらないまま 2 分を超えると、ログを見るよう出る", async () => {
      await service.holdRestarts();
      if (!held) throw new Error("no input held");
      daemon.send(commandResult(held));
      await expect.poll(() => hub.proc.log(), { timeout: 60_000 }).toContain("gasho-hub ended (75)");
      const slow = row.getByText("起動し直してから2分以上たっても、つながりません。");
      await expect(row).toContainText("0.90.1 に更新しています：切り替えて、起動し直しています");
      await expect(slow).toHaveCount(0);
      await moveClock(page, 121_000);
      await expect(slow).toBeVisible();
    });

    await test.step("起動し直した新しいバージョンにつながると、ページはそのバージョンの画面に読み込み直され、試験のあと確定して、前のバージョンに戻すボタンが出る", async () => {
      await mark(page);
      await service.allowRestarts();
      await expect(row).toContainText("gasho-hub 0.90.1", AFTER_RESTART);
      await expect.poll(() => marked(page), AFTER_RESTART).toBe(false);
      await expect.poll(() => hub.proc.log(), AFTER_RESTART).toContain("0.90.1 started well; it is no longer on trial");
      await expect(row.getByRole("button", { name: "0.90.0 に戻す" })).toBeVisible();
      // The steps the screen showed too briefly to be seen, in the Gasho server's log, in order.
      const log = hub.proc.log();
      const order = ["installing", "checking", "waiting for the commands under way", "switched; ending so that the service starts it"].map((s) =>
        log.lastIndexOf(`update to 0.90.1: ${s}`),
      );
      expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? 0)))).toBe(true);
    });

    // The badge once updated is seen in the next test: in WebKit, with the page's clock installed, the sidebar's
    // drawer does not close on the page loaded again.
    await test.step("「0.90.0 に戻す」で、入っている前のバージョンへ戻し始める", async () => {
      await row.getByRole("button", { name: "0.90.0 に戻す" }).click();
      await expect(dialog.getByRole("heading")).toHaveText("Gasho サーバーを 0.90.0 に戻しますか？");
      await expect(dialog).toContainText("入っている 0.90.0 に切り替えて、Gasho サーバーを起動し直します。");
      await expect(dialog.getByRole("link")).toHaveCount(0);
      await dialog.getByRole("button", { name: "戻す", exact: true }).click();
      await expect(row).toContainText(/0\.90\.0 に更新しています：/);
    });
  });

  test("更新して読み込み直したページに、更新したと出る", async ({ page, hub }) => {
    test.fail(true, "#191 読み込み直したページは、更新を始めたことを覚えていないので、「0.90.1 に更新しました。」が出ない");
    test.slow();
    await hub.npm.set({ answers: [...((await hub.npm.table()).answers ?? []), await hubInstallAnswer("0.90.1")] });
    await page.goto("/#/devices");
    const row = serverRow(page);
    await mark(page);
    await row.getByRole("button", { name: "0.90.1 に更新" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "更新する" }).click();
    await expect.poll(() => hub.proc.log(), AFTER_RESTART).toContain("0.90.1 started well; it is no longer on trial");
    await expect.poll(() => marked(page), AFTER_RESTART).toBe(false);
    await expect(row).toContainText("gasho-hub 0.90.1");
    await expect(row).toContainText("0.90.1 に更新しました。");
    // Updated, the Gasho server has nothing to update to: the badge is gone.
    const item = await devicesItem(page);
    await expect(item).not.toContainText("更新");
    await openDevices(page, item);
  });
});

test.describe("試験中の Gasho サーバー", () => {
  test.use({
    hubOptions: {
      service: { version: "0.90.1", trialFrom: "0.90.0" },
      npm: [npmLatestAnswer(DAEMON_PACKAGE, DAEMON), npmLatestAnswer(HUB_PACKAGE, "0.90.1")],
      // Long enough for the test to stop it before it is confirmed.
      env: { GASHO_HUB_PROBATION_MS: "600000" },
    },
  });

  test("試験中に止まると前のバージョンに自動で戻り、そのことと理由が出て、戻したバージョンはバッジに出ない", async ({ page, hub }) => {
    test.slow();
    const service = hub.service;
    if (!service) throw new Error("the Gasho server does not run as a service");
    await page.clock.install();
    await page.goto("/#/devices");
    const row = serverRow(page);

    await test.step("試験中は、確かめていることと、前のバージョンに戻すボタンが出る", async () => {
      await expect(row).toContainText("gasho-hub 0.90.1");
      await expect(row).toContainText("新しいバージョンを確かめています（1分ほど。起動できなければ、自動で前のバージョンに戻ります）");
      await expect(row.getByRole("button", { name: "0.90.0 に戻す" })).toBeVisible();
    });

    await test.step("確定する前に止まると、前のバージョンに自動で戻り、そのことと理由が出る", async () => {
      service.crash();
      await expect(row).toContainText("gasho-hub 0.90.0", AFTER_RESTART);
      await expect(row).toContainText(
        "0.90.1 がうまく起動しなかったので、0.90.0 に自動で戻しました（たった今）。起動したあと、確かめが済む前に止まりました。",
      );
    });

    await test.step("自動で戻したバージョンは、行では更新できるが、サイドバーのバッジには出ない", async () => {
      await expect(row).toContainText("0.90.1 に更新できます。");
      await expect(row.getByRole("button", { name: "0.90.1 に更新" })).toBeVisible();
      const item = await devicesItem(page);
      await expect(item).not.toContainText("更新");
      await openDevices(page, item);
    });

    await test.step("時計を進めると、自動で戻した時刻が変わる", async () => {
      await moveClock(page, 3600_000);
      await expect(row).toContainText("0.90.0 に自動で戻しました（1 時間前）。");
    });
  });
});

test.describe("常駐させずに動かしている Gasho サーバー", () => {
  test.use({ hubOptions: { service: { version: "0.90.0", asService: false }, npm: [npmLatestAnswer(DAEMON_PACKAGE, DAEMON), npmLatestAnswer(HUB_PACKAGE, "0.90.1")] } });

  test("更新できない理由と、常駐させるコマンドを出し、押すとコピーする", async ({ page }) => {
    await recordCopies(page);
    await page.goto("/#/devices");
    const row = serverRow(page);
    await expect(row).toContainText("0.90.1 が公開されています。");
    await expect(row).toContainText("常駐させずに動かしているので、Gasho からは更新できません。");
    await expect(row.getByRole("button", { name: "0.90.1 に更新" })).toHaveCount(0);
    await row.getByRole("button", { name: "npx @4rtofl/gasho-hub@latest service install" }).click();
    await expect.poll(() => copied(page)).toEqual(["npx @4rtofl/gasho-hub@latest service install"]);
    const item = await devicesItem(page);
    await expect(item).not.toContainText("更新");
    await openDevices(page, item);
  });
});
