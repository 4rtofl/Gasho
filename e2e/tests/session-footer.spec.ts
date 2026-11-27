// The footer of the session screen (4rtofl/Gasho#298): the connection and this browser's name, the working server's
// memory, the context window and the Claude.ai plan's usage limits, the details they open, and on an iPhone, the footer
// right under the chat box taking the home indicator's room.
import type { Page } from "@playwright/test";
import type { HubToDaemon, PlanUsage } from "@gasho/protocol";
import type { FakeDaemon } from "../harness/index.ts";
import { chatBox, expect, test } from "./fixtures.ts";
import { openSession, SESSION_ID } from "./session-helpers.ts";

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const footer = (page: Page) => page.getByTestId("session-footer");
const details = (page: Page) => page.getByRole("dialog", { name: "使用量" });
const asked = (d: FakeDaemon) => d.received.filter((m: HubToDaemon) => m.type === "usage.get").length;

/** A session that has replied: its context window and the limits its status line reported. */
const replied = () => ({
  context: { used: 72_400, size: 200_000, percent: 36, at: Date.now() - 60_000 },
  limits: { fiveHour: { percent: 18, resetsAt: Date.now() + 2 * HOUR }, sevenDay: { percent: 41, resetsAt: Date.now() + 72 * HOUR }, at: Date.now() - 60_000 },
});

const READ = (): PlanUsage => ({
  at: Date.now(),
  available: true,
  fiveHour: { percent: 18, resetsAt: Date.now() + 2 * HOUR },
  sevenDay: { percent: 41, resetsAt: Date.now() + 72 * HOUR },
  models: [{ name: "Fable", percent: 12, resetsAt: Date.now() + 72 * HOUR }],
});

test("Footer に接続・メモリ・コンテキスト・上限を出し、押すと詳細を出す。モデルごとの週の上限は gasho-daemon が get_usage で読む", async ({ page, hub, isMobile }) => {
  // A wide screen shows all of it; a narrower one leaves out the amounts and the reset times first.
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 900 });
  const daemon = await openSession(page, hub, {
    session: replied(),
    daemon: { capabilities: { canReadUsage: true } },
    setup: (d) => d.handle("usage.get", () => ({ type: "usage", usage: READ() })),
  });
  daemon.send({ type: "memory", memory: { total: 16 * GB, used: 9.9 * GB } });
  const f = footer(page);

  await test.step("画面を開くと、gasho-daemon に上限を読ませ、Fable の週の上限まで出す", async () => {
    await expect.poll(() => asked(daemon)).toBeGreaterThan(0);
    if (isMobile) {
      await expect(f.getByRole("button", { name: /^接続中。mac のメモリ 62%/ })).toBeVisible();
      await expect(f.getByRole("button", { name: "コンテキスト 36% 使用。詳細を開く" })).toBeVisible();
      await expect(f.getByRole("button", { name: "5時間の上限 18%。詳細を開く" })).toBeVisible();
      await expect(f.getByRole("button", { name: "週の上限（すべてのモデル） 41%。詳細を開く" })).toBeVisible();
      // The phone's footer leaves out what does not fit its width: Fable may be among them on an iPhone 15.
    } else {
      await expect(f.getByText("接続中 · e2e-browser", { exact: true })).toBeVisible();
      await expect(f.getByRole("meter", { name: "mac のメモリ使用率" })).toHaveAttribute("aria-valuenow", "62");
      await expect(f.getByText("9.9 / 16.0 GB")).toBeVisible();
      await expect(f.getByText("72.4k / 200k")).toBeVisible();
      await expect(f.getByRole("button", { name: "週の上限（Fable） 12%。使用量の詳細を開く" })).toBeVisible();
      await expect(f.getByText("2:00 後")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("footer-1440.png") });
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(f.getByText("2:00 後")).toBeHidden();
      await expect(f.getByRole("button", { name: "週の上限（Fable） 12%。使用量の詳細を開く" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("footer-1024.png") });
    }
    // A footer of one line.
    expect((await f.boundingBox())!.height).toBeLessThanOrEqual(isMobile ? 40 : 30);
  });

  await test.step("コンテキストを押すと、コンテキストと上限の詳細を出し、もう一度押すと閉じる", async () => {
    const context = f.getByRole("button", { name: /^コンテキスト 36% 使用。/ });
    await context.click();
    const panel = details(page);
    await expect(panel.getByText("72,400 / 200,000 トークン")).toBeVisible();
    await expect(panel.getByRole("meter", { name: "週の上限（Fable）" })).toHaveAttribute("aria-valuenow", "12");
    await expect(panel.getByText(/^Claude\.ai から読んだ値/)).toBeVisible();
    if (isMobile) await expect(panel.getByText("接続中 · e2e-browser", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("details.png") });
    await context.click();
    await expect(panel).toBeHidden();
  });

  await test.step("ホームには Footer を出さない", async () => {
    await page.screenshot({ path: test.info().outputPath("footer.png") });
    await page.goto("/#/");
    await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
    await expect(footer(page)).toHaveCount(0);
  });
});

test("値の無いものは出さない。読めないときは理由を出し、「読み直す」で読み直す", async ({ page, hub, isMobile }) => {
  // Before the first reply: no context window, no limits; the working server tells no memory.
  const daemon = await openSession(page, hub, {
    daemon: { capabilities: { canReadUsage: true } },
    setup: (d) => d.handle("usage.get", () => ({ type: "usage", error: "使用量の上限を読めませんでした（Error: not logged in）。" })),
  });
  const f = footer(page);
  await expect.poll(() => asked(daemon)).toBe(1);
  await expect(f.getByRole("button", { name: /コンテキスト/ })).toHaveCount(0);
  await expect(f.getByRole("button", { name: /上限/ })).toHaveCount(0);
  if (isMobile) return;
  await expect(f.getByText("未対応")).toBeVisible();

  // Once the session has replied, the status line's limits show, and the details say why the models' are missing.
  daemon.updateSession(SESSION_ID, replied());
  await f.getByRole("button", { name: /^コンテキスト 36% 使用。/ }).click();
  const panel = details(page);
  await expect(panel.getByText("使用量の上限を読めませんでした（Error: not logged in）。 モデルごとの週の上限は出せません。")).toBeVisible();
  await expect(panel.getByText(/^最後の返答の時点/).first()).toBeVisible();
  daemon.handle("usage.get", () => ({ type: "usage", usage: READ() }));
  await panel.getByRole("button", { name: "読み直す" }).click();
  await expect(panel.getByRole("meter", { name: "週の上限（Fable）" })).toBeVisible();
  expect(asked(daemon)).toBe(2);
});

test("古い gasho-daemon には読ませず、ステータスラインの上限だけを出す", async ({ page, hub, isMobile }) => {
  const daemon = await openSession(page, hub, { session: replied() });
  await expect(footer(page).getByRole("button", { name: /^週の上限（すべてのモデル） 41%/ })).toBeVisible();
  await footer(page).getByRole("button", { name: /^コンテキスト 36% 使用。/ }).click();
  await expect(details(page).getByText("この working server の gasho-daemon は古いため、モデルごとの週の上限を読めません。")).toBeVisible();
  expect(asked(daemon)).toBe(0);
  if (!isMobile) await expect(details(page).getByRole("button", { name: "読み直す" })).toHaveCount(0);
});

test("iPhone では、Footer が入力欄のすぐ下でホームインジケーターの余白を受け持ち、文字数の行を出さない", async ({ page, hub, isMobile }) => {
  test.skip(!isMobile, "iPhone の幅だけ");
  const daemon = await openSession(page, hub, { session: replied() });
  // WebKit's iPhone has no notch: the home indicator's 34px is given as the safe area would be.
  await page.addStyleTag({ content: ":root { --safe-bottom: 34px !important; }" });
  daemon.send({ type: "memory", memory: { total: 16 * GB, used: 9.9 * GB } });
  const f = footer(page);
  await expect(f.getByRole("button", { name: /^接続中。mac のメモリ 62%/ })).toBeVisible();
  await expect(page.getByText("0/20000")).toHaveCount(0);

  const viewport = page.viewportSize()!;
  const bar = page.locator("footer", { has: f });
  const footerBox = (await bar.boundingBox())!;
  const lineBox = (await f.boundingBox())!;
  const card = (await chatBox(page).locator("xpath=ancestor::div[contains(@class,'rounded-[24px]')][1]").boundingBox())!;
  // The footer ends at the bottom of the screen, its line above the home indicator's 34px.
  expect(Math.round(footerBox.y + footerBox.height)).toBe(viewport.height);
  expect(Math.round(footerBox.y + footerBox.height - (lineBox.y + lineBox.height))).toBe(34);
  // The chat box is right above it: no line of the count between them.
  expect(footerBox.y - (card.y + card.height)).toBeLessThanOrEqual(12);
  await page.screenshot({ path: test.info().outputPath("iphone.png") });

  // Near the limit, the count shows in the box.
  await chatBox(page).fill("あ".repeat(17_500));
  await expect(page.getByText("17500/20000")).toBeVisible();
});

test("ホーム画面の Web アプリで html を画面の高さにする規則は、viewport が画面いっぱいのときは何も変えない", async ({ page, hub, isMobile }) => {
  // iOS 26's Home Screen app, whose viewport is short by the status bar until the page is as tall as the screen
  // (4rtofl/Gasho#312), is not reproduced here, nor is display-mode: standalone: the rule is taken out of its media query
  // and applied as it is, with the iPhone's insets, on a viewport that is the whole screen already.
  if (!isMobile) await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page, hub, { session: replied() });
  await page.addStyleTag({ content: ":root { --safe-top: 62px !important; --safe-bottom: 34px !important; }" });
  const f = footer(page);
  await expect(f).toBeVisible();
  // The rule as the built stylesheet has it, without its media query (the page's code is given as text: e2e has no DOM types).
  const rule = await page.evaluate<string>(`[...document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .filter((r) => r instanceof CSSMediaRule && r.conditionText.includes("display-mode: standalone"))
    .flatMap((r) => [...r.cssRules].map((x) => x.cssText))
    .join("\\n")`);
  expect(rule).toContain("min-height: min(100lvh, calc(100% + var(--safe-top)))");
  const bar = page.locator("footer", { has: f });
  const before = (await bar.boundingBox())!;
  await page.addStyleTag({ content: rule });

  const viewport = page.viewportSize()!;
  // The page is no taller than the viewport, and does not scroll; the footer stays at the bottom edge.
  expect(await page.evaluate<number>("document.documentElement.getBoundingClientRect().height")).toBe(viewport.height);
  expect(await page.evaluate<number>("document.documentElement.scrollHeight")).toBe(viewport.height);
  expect(await bar.boundingBox()).toEqual(before);
  expect(Math.round(before.y + before.height)).toBe(viewport.height);
  await page.screenshot({ path: test.info().outputPath("standalone-rule.png") });
});
