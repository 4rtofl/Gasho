// The 端末 screen: a registration code and its time, the command that registers a working server, the table of the
// browsers and working servers (its search, sort, cards, empty text, connected or not), renaming and revoking them,
// and what a revoked working server leaves in the sidebar and in the commands sent to it (#98).
import type { Browser, Page } from "@playwright/test";
import { fakeSession, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { closeSidebar, onPhone, openSidebar } from "./screen.ts";

const rowOf = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
/** The registration code shown (ABCD-2345). */
const codeOf = (page: Page) => page.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

/** Another browser, registered, on the 端末 screen as a computer (its table, not its cards). */
async function otherBrowser(browser: Browser, hub: GashoHub): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL: hub.url });
  await context.addCookies([await hub.browserCookie("e2e-other")]);
  const page = await context.newPage();
  await page.goto("/#/devices");
  return { page, close: () => context.close() };
}

test("「コードを発行」で残り時間が 1 秒ごとに減り、0 で「期限切れ」になる。2 回目からは「新しいコードを発行」", async ({ page }) => {
  await page.clock.install();
  await page.goto("/#/devices");
  await page.getByRole("button", { name: "コードを発行", exact: true }).click();
  const left = page.getByText(/^あと \d+ 分 \d+ 秒$/);
  await expect(left).toBeVisible();
  await page.clock.pauseAt(Date.now() + 1000);

  const seconds = async () => {
    const m = /^あと (\d+) 分 (\d+) 秒$/.exec(await left.innerText());
    if (!m) throw new Error("no time left shown");
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const first = await seconds();
  // A code lasts 10 minutes.
  expect(first).toBeGreaterThan(9 * 60);
  expect(first).toBeLessThanOrEqual(10 * 60);
  await page.clock.runFor(1000);
  expect(await seconds()).toBe(first - 1);
  await page.clock.runFor(3000);
  expect(await seconds()).toBe(first - 4);

  await page.clock.fastForward((first - 4) * 1000);
  await expect(page.getByText("期限切れ", { exact: true })).toBeVisible();

  const code = await codeOf(page).innerText();
  await page.getByRole("button", { name: "新しいコードを発行" }).click();
  await expect(codeOf(page)).not.toHaveText(code);
});

test("working server を登録するコマンドを押すと、そのコマンドがコピーされる", async ({ page, hub }) => {
  // The clipboard is the browser's: what the page hands it is kept here instead.
  await page.addInitScript(() => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "e2eCopied", { value: copied });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) } });
  });
  await page.goto("/#/devices");
  await page.getByRole("button", { name: "コードを発行", exact: true }).click();
  const code = await codeOf(page).innerText();
  const command = `node apps/daemon/src/cli.ts register --server ${hub.url} --code ${code}`;
  await page.getByRole("button", { name: command }).click();
  await expect.poll(() => page.evaluate("globalThis.e2eCopied")).toEqual([command]);
});

test("表の検索・見出しでの並べ替え・640px 未満のカード・0 件の文・working server の「接続中」「未接続」", async ({ page, hub }) => {
  const mac = await hub.fakeDaemon({ name: "mac" });
  await hub.fakeDaemon({ name: "linux" });
  await page.goto("/#/devices");
  const rows = page.getByRole("row").filter({ has: page.getByRole("cell") });
  await expect(rows).toHaveCount(3);
  await expect(rowOf(page, "e2e-browser")).toContainText("この端末");
  await expect(rowOf(page, "mac")).toContainText("接続中");

  await mac.disconnect();
  await expect(rowOf(page, "mac")).toContainText("未接続");
  await expect(rowOf(page, "linux")).toContainText("接続中");

  const search = page.getByRole("searchbox", { name: "行を検索" });
  await search.fill("linux");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("linux");
  await search.fill("見つからない名前");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("登録済みの端末はありません。")).toBeVisible();
  await search.fill("");
  await expect(rows).toHaveCount(3);

  // Registered first first, then by name, both ways.
  await expect(rows.nth(0)).toContainText("e2e-browser");
  await expect(rows.nth(2)).toContainText("linux");
  if (onPhone(page)) {
    // Cards: no headings; a list picks what to sort by, and a button which way.
    await expect(page.getByRole("columnheader")).toHaveCount(0);
    // The way stays as it was (the default sort's, ascending).
    await page.getByRole("combobox").selectOption({ label: "並べ替え：名前" });
    await expect(rows.nth(0)).toContainText("e2e-browser");
    await expect(rows.nth(2)).toContainText("mac");
    await page.getByRole("button", { name: /Switch to descending/ }).click();
    await expect(rows.nth(0)).toContainText("mac");
    return;
  }
  await page.getByRole("button", { name: "名前", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "名前" })).toHaveAttribute("aria-sort", "ascending");
  await expect(rows.nth(0)).toContainText("e2e-browser");
  await expect(rows.nth(2)).toContainText("mac");
  await page.getByRole("button", { name: "名前", exact: true }).click();
  await expect(rows.nth(0)).toContainText("mac");

  // Below 640px of its own width, the table turns into cards.
  await expect(page.getByRole("columnheader")).not.toHaveCount(0);
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.getByRole("columnheader")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveValue("name");
  await expect(rows).toHaveCount(3);
});

test("「名前を変更」は window.prompt で名前を聞き、「取り消す」は window.confirm で確かめる", async ({ page, hub }) => {
  await hub.fakeDaemon({ name: "mac" });
  await hub.fakeDaemon({ name: "linux" });
  await page.goto("/#/devices");

  page.once("dialog", (dialog) => {
    expect(dialog.type()).toBe("prompt");
    expect(dialog.defaultValue()).toBe("mac");
    void dialog.accept("  mac-mini  ");
  });
  await rowOf(page, "mac").getByRole("button", { name: "名前を変更" }).click();
  // A regular expression: a string would be compared with the spaces around the name taken away.
  await expect(rowOf(page, "mac-mini").getByText("mac-mini", { exact: true })).toHaveText(/^mac-mini$/);

  // Dismissed: nothing changes.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await rowOf(page, "linux").getByRole("button", { name: "名前を変更" }).click();
  page.once("dialog", (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("「linux」の登録を取り消しますか？");
    void dialog.dismiss();
  });
  await rowOf(page, "linux").getByRole("button", { name: "取り消す" }).click();
  await expect(rowOf(page, "linux")).toHaveCount(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await rowOf(page, "linux").getByRole("button", { name: "取り消す" }).click();
  await expect(rowOf(page, "linux")).toHaveCount(0);
  await expect(rowOf(page, "mac-mini")).toHaveCount(1);
});

test("この端末を取り消すと、登録の画面に戻る", async ({ page }) => {
  await page.goto("/#/devices");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("このブラウザの登録を取り消しますか？");
    void dialog.accept();
  });
  await rowOf(page, "e2e-browser").getByRole("button", { name: "取り消す" }).click();
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();
  // The cookie is gone with it: the next visit is not registered either.
  await page.reload();
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();
});

test("取り消した working server が、サイドバーと実行中の指示に残らない（#98）", async ({ page, hub, browser }) => {
  const sessionId = "6f8a0c2e-4b6d-4f1a-8c3e-5a7b9d1f3e5c";
  const mac = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId, cwd: "/work/gasho", name: "e2e-session" })] });
  const linux = await hub.fakeDaemon({ name: "linux", sessions: [fakeSession({ sessionId: "1a3c5e7a-9b2d-4f6a-8c0e-2b4d6f8a0c1e", cwd: "/work/other" })] });
  await linux.disconnect();
  // Typed into the session, but never answered: the screen waits for it.
  mac.handle("session.input", () => undefined);

  // The results of commands the page hears of: the screen of the session goes with the working server, and with it the
  // chat box that would tell the result.
  const results: { error?: string }[] = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      const m = JSON.parse(String(f.payload)) as { type?: string; result?: { error?: string } };
      if (m.type === "command.result" && m.result) results.push(m.result);
    }),
  );
  await page.goto(`/#/s/${encodeURIComponent(mac.machineId)}/${sessionId}`);
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
  const sidebar = page.getByRole("navigation", { name: "メニュー" });
  await openSidebar(page);
  await expect(sidebar.getByRole("button", { name: /^gasho/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^other/ })).toContainText("オフライン");
  await closeSidebar(page);

  const box = page.getByPlaceholder("Agent への指示を入力…");
  await box.fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  await mac.waitFor("session.input");

  const other = await otherBrowser(browser, hub);
  try {
    for (const name of ["mac", "linux"]) {
      other.page.once("dialog", (dialog) => void dialog.accept());
      await rowOf(other.page, name).getByRole("button", { name: "取り消す" }).click();
      await expect(rowOf(other.page, name)).toHaveCount(0);
    }
  } finally {
    await other.close();
  }

  // At once, not after the 160 s the screen waits for an answer.
  await expect.poll(() => results).toEqual([{ ok: false, error: "working server の登録が外されました。" }]);
  await expect(page.getByText("このセッションは見つかりません。", { exact: false })).toBeVisible();
  await openSidebar(page);
  await expect(sidebar.getByRole("button", { name: /^gasho/ })).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: /^other/ })).toHaveCount(0);
});
