// Gasho's scrollbars (packages/plugin-sdk/theme.css): thin (6px) where a place scrolls, in the conversation and in a
// file's code that scrolls sideways, and still hidden where a place hides its scrollbar (the sidebar). What a browser
// gives a scrollbar is the room between an element's border and its content (offset… less client… less the borders).
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { worktreeSession } from "./home-sidebar.ts";
import { FakeFolder, sessionDaemon, sessionUrl } from "./panel-data.ts";
import { numberedEntries, openSession } from "./session-helpers.ts";
import { openSidebar } from "./screen.ts";

/** What the function run in the page uses (e2e/ is type-checked without the DOM's types). */
type PageWindow = { getComputedStyle(e: unknown): { getPropertyValue(name: string): string } };
type PageElement = { offsetWidth: number; clientWidth: number; offsetHeight: number; clientHeight: number; scrollHeight: number };

/** The room that the scrollbars take, at the side (`y`, a vertical one) and at the bottom (`x`, a horizontal one). */
const scrollbar = (el: Locator) =>
  el.evaluate((e) => {
    const s = (globalThis as unknown as PageWindow).getComputedStyle(e);
    const border = (a: string, b: string) => parseFloat(s.getPropertyValue(a)) + parseFloat(s.getPropertyValue(b));
    const h = e as unknown as PageElement;
    return {
      y: h.offsetWidth - h.clientWidth - border("border-left-width", "border-right-width"),
      x: h.offsetHeight - h.clientHeight - border("border-top-width", "border-bottom-width"),
      overflows: h.scrollHeight > h.clientHeight,
    };
  });

// Playwright starts a headless Chromium with --hide-scrollbars, which draws none.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });
// A phone's browser (WebKit with touch) draws its scrollbars over the content, taking no room, whatever the CSS says.
test.skip(({ isMobile }) => isMobile, "スマホでは、スクロールバーは内容に重ねて描かれ、場所を取らない");

test("会話は 6px のスクロールバーでスクロールし、サイドバーはスクロールバーを隠したまま", async ({ page, hub }) => {
  const many = Array.from({ length: 30 }, (_, i) => worktreeSession(`s-${i}`, { branch: `feat/scroll-${i}` }));
  await openSession(page, hub, { transcript: numberedEntries(40), daemon: { sessions: many } });
  await expect(page.getByText("発言 40", { exact: true })).toBeVisible();

  await test.step("会話", async () => {
    const conversation = page.locator(".chat-text").locator("xpath=ancestor::*[contains(@class, 'overflow-y-auto')][1]");
    expect(await scrollbar(conversation)).toMatchObject({ y: 6, overflows: true });
  });

  await test.step("サイドバー", async () => {
    await openSidebar(page);
    const nav = page.getByRole("navigation", { name: "メニュー" });
    await expect(nav.getByText("feat/scroll-29", { exact: true })).toBeAttached();
    // The worktrees' list scrolls on its own, below the items above it (or the whole menu, when it is short).
    const list = nav.locator("[data-sort-row]").first().locator("xpath=ancestor::*[contains(@class, 'overflow-y-auto')][1]");
    expect(await scrollbar(list)).toMatchObject({ y: 0, overflows: true });
  });
});

test("ファイルのコードの長い行は、6px のスクロールバーで横にスクロールする", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  const long = `${"x".repeat(400)}の終わり`;
  new FakeFolder(d).text("wide.txt", `${long}\n短い行\n`);
  await page.goto(sessionUrl(d, "/file/wide.txt"));
  await expect(page.getByRole("button", { name: "折り返す" })).toHaveAttribute("aria-pressed", "false");
  const code = page.getByText(long).locator("xpath=ancestor::*[contains(@class, 'overflow-x-auto')][1]");
  expect((await scrollbar(code)).x).toBe(6);
});
