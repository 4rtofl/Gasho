// Registering a browser on the screen: the registration screen of a browser not registered, its code and name, the codes
// the Gasho server refuses and how often it lets one try, the name it starts with, and a Gasho server that is down.
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { expectConnection } from "./screen.ts";

const WRONG_CODE = "コードが正しくないか、使用済みか、期限が切れています。";

/** Uses up a code, as another browser that registered with it. */
async function useCode(hub: GashoHub, code: string): Promise<void> {
  const res = await fetch(`${hub.url}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, kind: "browser", name: "other" }) });
  expect(res.status).toBe(201);
}

/** Makes the codes not used yet expire: the Gasho server's clock cannot be moved from the test. */
function expireCodes(hub: GashoHub): void {
  const db = new DatabaseSync(path.join(hub.root, "hub", "hub.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE pairing_codes SET expires_at = 1 WHERE used_at IS NULL").run();
  } finally {
    db.close();
  }
}

// The fixture registers the context's browser; these scenarios start from one that is not.
test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test("登録していないブラウザーで開くと登録の画面が出て、正しいコードと名前で登録するとホームが出る", async ({ page, hub }) => {
  await page.goto("/");
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();

  await page.getByLabel("登録コード").fill(await hub.pairingCode());
  await page.getByLabel("この端末の名前").fill("e2e-new");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
  await expectConnection(page, true, "e2e-new");

  // Registered: the Gasho server set the cookie, and the next visit opens the home screen.
  await page.reload();
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
});

test("コードは大文字になり、コードか名前が空のあいだは「登録する」を押せず、名前は 60 文字まで", async ({ page }) => {
  await page.goto("/");
  const code = page.getByLabel("登録コード");
  const name = page.getByLabel("この端末の名前");
  const submit = page.getByRole("button", { name: "登録する" });

  await code.pressSequentially("abcd-2345");
  await expect(code).toHaveValue("ABCD-2345");

  await name.fill("");
  await expect(submit).toBeDisabled();
  await name.fill("   ");
  await expect(submit).toBeDisabled();
  await name.fill("e2e");
  await expect(submit).toBeEnabled();
  await code.fill("");
  await expect(submit).toBeDisabled();

  await name.fill("");
  await name.pressSequentially("あ".repeat(61));
  await expect(name).toHaveValue("あ".repeat(60));
});

test("誤ったコード・使用済みのコード・期限の切れたコードで「コードが正しくないか…」が出る", async ({ page, hub }) => {
  await page.goto("/");
  const code = page.getByLabel("登録コード");
  const submit = page.getByRole("button", { name: "登録する" });
  const error = page.getByText(WRONG_CODE);

  await code.fill("ZZZZ-9999");
  await submit.click();
  await expect(error).toBeVisible();

  const used = await hub.pairingCode();
  await useCode(hub, used);
  await code.fill(used);
  await submit.click();
  // The same text as before: it shows again once the answer came (the button says 登録しています… meanwhile).
  await expect(submit).toBeEnabled();
  await expect(error).toBeVisible();

  const expired = await hub.pairingCode();
  expireCodes(hub);
  await code.fill(expired);
  await submit.click();
  await expect(submit).toBeEnabled();
  await expect(error).toBeVisible();
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();
});

test("10 分に 11 回目の試行で「試行が多すぎます」が出て、正しいコードでも登録できない", async ({ page, hub }) => {
  // The 9 wrong codes before it, from the same address as the browser's (the loopback).
  for (let i = 0; i < 9; i++) {
    const res = await fetch(`${hub.url}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "ZZZZ-9999", kind: "browser", name: "x" }) });
    expect(res.status).toBe(400);
  }
  await page.goto("/");
  const code = page.getByLabel("登録コード");
  const submit = page.getByRole("button", { name: "登録する" });

  await code.fill("ZZZZ-9999");
  await submit.click();
  await expect(page.getByText(WRONG_CODE)).toBeVisible();

  await code.fill(await hub.pairingCode());
  await submit.click();
  await expect(page.getByText("試行が多すぎます。数分待ってから、もう一度入力してください。")).toBeVisible();
  await expect(page.getByText("このブラウザを登録する")).toBeVisible();
});

test("端末名の初期値が、ブラウザーの UA で変わる", async ({ browser, hub }) => {
  const cases: { ua: string; touch?: number; name: string }[] = [
    { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", name: "iPhone" },
    { ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", name: "iPad" },
    // An iPad says it is a Mac; it is told apart by its touch points.
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", touch: 5, name: "iPad" },
    { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", touch: 0, name: "Mac" },
    { ua: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", name: "Android" },
    { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", name: "Windows" },
    { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", name: "Linux" },
    { ua: "e2e-unknown-browser", name: "ブラウザ" },
  ];
  for (const c of cases) {
    const context = await browser.newContext({ userAgent: c.ua, baseURL: hub.url });
    try {
      if (c.touch !== undefined) {
        const touch = c.touch;
        await context.addInitScript((n) => Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => n }), touch);
      }
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByLabel("この端末の名前"), c.ua).toHaveValue(c.name);
    } finally {
      await context.close();
    }
  }
});

test("Gasho サーバーが止まっていると「つながりません」が出て、戻ると自動で登録の画面に進む", async ({ page, hub }) => {
  // The page itself comes from the Gasho server, so it stops once the page has loaded: when the page asks who it is.
  let stopped = false;
  await page.route("**/api/me", async (route) => {
    if (!stopped) {
      stopped = true;
      await hub.stopServer();
      await route.abort("connectionrefused");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("Gasho サーバーにつながりません。再試行しています…")).toBeVisible();

  await hub.startServer();
  // It tries again every 5 s.
  await expect(page.getByText("このブラウザを登録する")).toBeVisible({ timeout: 30_000 });
});
