// The page's connection to the Gasho server: what it tells while the connection is down, what it reads again once it is
// back, what sending does meanwhile, when it connects again without waiting, and a browser revoked elsewhere.
import type { Page } from "@playwright/test";
import type { HubToDaemon } from "@gasho/protocol";
import { type FakeDaemon, fakeSession, textEntry } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { expectConnection, onPhone, routeConnection } from "./screen.ts";

const SESSION = "5d2a7c1e-3b4f-4e8a-9c6d-1f0e2b3a4c5d";
const BROWSER = "e2e-browser";

const sessionUrl = (d: FakeDaemon, panel = "") => `/#/s/${encodeURIComponent(d.machineId)}/${SESSION}${panel}`;
/** Scrolls the conversation to the top of what is loaded (run in the page). */
const SCROLL_TO_TOP = `(() => {
  const boxes = [...document.querySelectorAll("*")].filter(
    (el) => getComputedStyle(el).overflowY === "auto" && el.scrollHeight > el.clientHeight && (el.textContent ?? "").includes("会話の行"),
  );
  boxes.at(-1)?.scrollTo({ top: 0 });
})()`;
const countOf = (d: FakeDaemon, type: HubToDaemon["type"]) => d.received.filter((m) => m.type === type).length;

async function openSession(page: Page, d: FakeDaemon): Promise<void> {
  await page.goto(sessionUrl(d));
  await expect(page.getByRole("heading", { name: "e2e-session" })).toBeVisible();
}

test("Gasho サーバーを止めると「再接続中…」になり、戻すと「接続中 · 端末名」に戻る", async ({ page, hub }) => {
  await page.goto("/");
  await expectConnection(page, true, BROWSER);

  await hub.stopServer();
  await expectConnection(page, false, BROWSER);

  await hub.startServer();
  // It tries again after 1 s, 2 s, 4 s … up to 15 s, and the Gasho server may take a while to start.
  await expectConnection(page, true, BROWSER, 60_000);
});

test("つなぎ直したあと、開いていた会話と、読み込み中だったグラフ・フォルダー・ファイルを読み直す", async ({ page, hub }) => {
  const d = await hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session", gitBranch: "main" })],
    transcripts: { [SESSION]: [textEntry("assistant", "切れる前の会話")] },
  });
  // Not answered before the connection drops: the requests are lost with it.
  d.handle("git.graph.get", () => undefined);
  d.handle("dir.get", () => undefined);
  d.handle("file.get", () => undefined);
  const conn = await routeConnection(page);
  await openSession(page, d);
  await expect(page.getByText("切れる前の会話")).toBeVisible();
  for (const [panel, type] of [["/graph", "git.graph.get"], ["/files", "dir.get"], ["/file/README.md", "file.get"]] as const) {
    await page.evaluate(`location.hash = ${JSON.stringify(sessionUrl(d, panel).slice(1))}`);
    await d.waitFor(type);
  }
  const before = countOf(d, "transcript.get");

  d.handle("file.get", (m) => ({
    type: "file",
    requestId: m.requestId,
    sessionId: m.sessionId,
    path: m.path,
    file: { path: m.path, size: 30, mtime: Date.now(), text: "つなぎ直してから読んだ中身", writable: false },
  }));
  await conn.drop();
  // Written while the page was not connected: it does not hear of it.
  d.append(SESSION, [textEntry("assistant", "切れているあいだの会話")]);

  await expect(page.getByText("つなぎ直してから読んだ中身")).toBeVisible();
  expect(conn.made).toBe(2);
  await expect.poll(() => countOf(d, "transcript.get")).toBeGreaterThan(before);
  expect(countOf(d, "git.graph.get")).toBe(2);
  expect(countOf(d, "dir.get")).toBe(2);
  // On a phone the file takes the session's place.
  if (!onPhone(page)) await expect(page.getByText("切れているあいだの会話")).toBeVisible();
});

test("接続が切れているあいだに指示を送ると「Gasho サーバーにつながっていません。」が出て、指示は入力欄に残る", async ({ page, hub }) => {
  const d = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session" })] });
  await openSession(page, d);
  await hub.stopServer();
  await expectConnection(page, false, BROWSER);

  const box = page.getByPlaceholder("Agent への指示を入力…");
  await box.fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("Gasho サーバーにつながっていません。")).toBeVisible();
  await expect(box).toHaveValue("README を読んで");
  expect(countOf(d, "session.input")).toBe(0);
});

test("送った直後に接続が切れると、結果が分からないと出て、指示は入力欄に戻らない（#106）", async ({ page, hub }) => {
  const d = await hub.fakeDaemon({ name: "mac", sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session" })] });
  // Typed into the session, but its result is lost with the connection.
  d.handle("session.input", () => undefined);
  const conn = await routeConnection(page);
  await openSession(page, d);

  const box = page.getByPlaceholder("Agent への指示を入力…");
  await box.fill("README を読んで");
  await page.getByRole("button", { name: "送信" }).click();
  await d.waitFor("session.input");
  await conn.drop();
  await expect(page.getByText(/分かりません/)).toBeVisible();
  await expect(box).toHaveValue("");
});

test("つなぎ直したあとも、遡って読み込んだ会話が残る（#106）", async ({ page, hub }) => {
  const row = (i: number) => `会話の行 ${String(i).padStart(3, "0")}`;
  const d = await hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId: SESSION, cwd: "/work/gasho", name: "e2e-session" })],
    transcripts: { [SESSION]: Array.from({ length: 200 }, (_, i) => textEntry("assistant", row(i))) },
  });
  const conn = await routeConnection(page);
  await openSession(page, d);
  await expect(page.getByText(row(199), { exact: true })).toBeVisible();

  // The screen reads the older pages (80 entries each) as it is scrolled up.
  const older = page.getByText(row(50), { exact: true });
  await expect
    .poll(async () => {
      await page.evaluate(SCROLL_TO_TOP);
      return older.count();
    })
    .toBe(1);

  // Written while the page was not connected: once it shows, the latest page read after reconnecting has come.
  d.transcripts[SESSION] = [...(d.transcripts[SESSION] ?? []), textEntry("assistant", row(200))];
  // Only the latest page is read from now on: the older rows have to be kept, not read again (at the top, the screen
  // would read them again at once).
  d.handle("transcript.get", (m) => {
    if (m.before !== undefined) return undefined;
    const all = d.transcripts[m.sessionId] ?? [];
    const start = Math.max(0, all.length - m.limit);
    return { type: "transcript.page", requestId: m.requestId, sessionId: m.sessionId, entries: all.slice(start), start, total: all.length };
  });
  await conn.drop();
  await expect(page.getByText(row(200), { exact: true })).toBeAttached();
  await expect(older).toBeAttached();
});

test("画面を隠して戻したときと online のときは、待たずにつなぎ直す", async ({ page }) => {
  // The clock stands still: the page's own next try (after 1 s) never comes, only the events make it connect.
  await page.clock.install();
  const conn = await routeConnection(page);
  await page.goto("/");
  await expectConnection(page, true, BROWSER);
  await page.clock.pauseAt(Date.now() + 1000);
  // The drawer's animations stand still too: on a phone, the top bar tells it.
  const down = onPhone(page) ? page.getByRole("banner").getByText("再接続中…", { exact: true }) : page.getByText(`再接続中… · ${BROWSER}`, { exact: true });

  for (const [what, fire] of [
    ["visibilitychange", () => page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`)],
    ["online", () => page.evaluate(`window.dispatchEvent(new Event("online"))`)],
  ] as const) {
    const made = conn.made;
    await conn.drop();
    await expect(down, what).toBeVisible();
    await page.waitForTimeout(1500);
    expect(conn.made, `${what}: 時計が止まっているので、自分ではつなぎ直さない`).toBe(made);
    await fire();
    await expect(down, what).toBeHidden({ timeout: 5000 });
    expect(conn.made).toBe(made + 1);
  }
});

test("別のブラウザーからこの端末を取り消すと、登録の画面に戻る", async ({ page, hub, browser }) => {
  await page.goto("/");
  await expectConnection(page, true, BROWSER);

  const other = await browser.newContext({ baseURL: hub.url });
  try {
    await other.addCookies([await hub.browserCookie("e2e-other")]);
    const otherPage = await other.newPage();
    await otherPage.goto("/#/devices");
    otherPage.once("dialog", (dialog) => void dialog.accept());
    await otherPage.getByRole("row").filter({ hasText: BROWSER }).getByRole("button", { name: "取り消す" }).click();
    await expect(otherPage.getByRole("row").filter({ hasText: BROWSER })).toHaveCount(0);
  } finally {
    await other.close();
  }
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();
});
