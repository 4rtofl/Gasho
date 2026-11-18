// A page whose build of the screen is no longer the one the Gasho server serves (after an update, or npm run web:build):
// it reloads itself, unless something not sent or not saved is being written in it; then a band offers to reload.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { type FakeDaemon, fakeSession, GASHO_DIR } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { expectConnection, openSidebar } from "./screen.ts";

const SESSION = "8e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const BAND = "Gasho が新しいバージョンになりました。";

// A copy of the built screen for each test: its build.json is what the Gasho server tells pages, and it changes here.
test.use({
  hubOptions: async ({}, use) => {
    const webDist = await fs.mkdtemp(path.join(os.tmpdir(), "ge2e-web-"));
    await fs.cp(path.join(GASHO_DIR, "apps/web/dist"), webDist, { recursive: true });
    await use({ webDist });
    await fs.rm(webDist, { recursive: true, force: true });
  },
});

let builds = 0;
/** Makes the Gasho server serve another build: it watches build.json, and tells the pages. */
async function newBuild(webDist: string | undefined): Promise<void> {
  if (!webDist) throw new Error("no copy of the screen");
  await fs.writeFile(path.join(webDist, "build.json"), `${JSON.stringify({ build: `e2e-${process.pid}-${++builds}` })}\n`);
}

/** Marks this page, to tell whether it was loaded again (the mark goes with it). */
const mark = (page: Page) => page.evaluate("window.e2eMark = true");
const marked = (page: Page) => page.evaluate("window.e2eMark === true");

test("書きかけが無ければ、ビルドが変わると自動で読み込み直す。60 秒以内に同じ版のためには 2 回目を読み込み直さず、帯を出す", async ({ page, hubOptions }) => {
  await page.goto("/");
  await expectConnection(page, true, "e2e-browser");
  await mark(page);

  const reloaded = page.waitForEvent("load");
  await newBuild(hubOptions.webDist);
  await reloaded;
  expect(await marked(page)).toBe(false);
  // The page loaded again is of the same build as before (the screen's files did not change, only build.json): it is
  // still out of date, and it reloaded itself for this build a moment ago.
  await expect(page.getByText(BAND)).toBeVisible();

  await mark(page);
  const again = page.waitForEvent("load");
  await page.getByRole("button", { name: "読み込み直す" }).click();
  await again;
  await expect(page.getByText(BAND)).toBeVisible();
  expect(await marked(page)).toBe(false);
});

/** `make` writes something in the page; `close` puts away what keeps the band's button from being pressed. */
const busy: { what: string; make: (page: Page, d: FakeDaemon) => Promise<void>; close?: (page: Page) => Promise<void> }[] = [
  {
    what: "チャット欄の書きかけ",
    make: async (page, d) => {
      await page.goto(`/#/s/${encodeURIComponent(d.machineId)}/${SESSION}`);
      await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
      const box = page.getByPlaceholder("Agent への指示を入力…");
      await box.fill("あとで送る指示");
      await box.blur();
    },
  },
  {
    what: "未保存のファイル",
    make: async (page, d) => {
      d.handle("file.get", (m) => ({
        type: "file",
        requestId: m.requestId,
        sessionId: m.sessionId,
        path: m.path,
        file: { path: m.path, size: 6, mtime: Date.now(), hash: "0".repeat(64), text: "# 見出し\n", writable: true },
      }));
      await page.goto(`/#/s/${encodeURIComponent(d.machineId)}/${SESSION}/file/README.md`);
      await page.getByRole("button", { name: "編集" }).click();
      const text = page.getByLabel("ファイルの内容");
      await text.fill("# 書き換えた見出し\n");
      await text.blur();
      await expect(page.getByText("未保存の変更があります")).toBeVisible();
    },
  },
  {
    what: "開いたダイアログ",
    make: async (page) => {
      await page.goto("/");
      await expect(page.getByRole("main").getByText("1 台の working server")).toBeVisible();
      await openSidebar(page);
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "リポジトリで絞り込む" }).click();
      await page.getByRole("menuitem", { name: "リポジトリを登録・解除…" }).click();
      await expect(page.getByRole("dialog", { name: "リポジトリの登録" })).toBeVisible();
    },
    close: async (page) => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "リポジトリの登録" })).toBeHidden();
    },
  },
  {
    what: "入力欄の文字",
    make: async (page) => {
      await page.goto("/#/devices");
      await expect(page.getByRole("row").filter({ hasText: "mac" }).getByText("接続中")).toBeVisible();
      await page.getByRole("searchbox", { name: "行を検索" }).fill("e2e");
    },
  },
];

for (const b of busy) {
  test(`${b.what}があると、読み込み直さずに帯と「読み込み直す」を出す`, async ({ page, hub, hubOptions }) => {
    const d = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session" })] });
    // Each waits for what the Gasho server's first message brings (the working server): the page is connected.
    await b.make(page, d);
    await mark(page);

    await newBuild(hubOptions.webDist);
    await expect(page.getByText(BAND)).toBeVisible();
    expect(await marked(page)).toBe(true);

    await b.close?.(page);
    const reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: "読み込み直す" }).click();
    await reloaded;
    // The page loaded again is still of the old build (only build.json changed), and with nothing written in it, it
    // reloads itself once more before it shows the band: then it has settled.
    await expect(page.getByText(BAND)).toBeVisible();
    expect(await marked(page)).toBe(false);
  });
}
