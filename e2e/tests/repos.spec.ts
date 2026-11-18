// Registering repositories with each working server (the dialog of "リポジトリを登録・解除…"): from the repositories
// of the folders Claude Code trusts, or a folder typed in; taking one off; what each working server's list says; and
// the sidebar, which lists the worktrees of a registered repository. Then "複数のリポジトリ…" of a session whose folder
// holds several repositories.
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import type { RegisteredRepo } from "@gasho/protocol";
import { commandResult, fakeSession } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { confirmConversion, deferred, openHome, sidebar } from "./launch-helpers.ts";
import { showHeader } from "./plugin-helpers.ts";

const APP: RegisteredRepo = { path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }, { path: "/work/app-feat", branch: "feat" }] };
const LIB: RegisteredRepo = { path: "/work/lib", worktrees: [{ path: "/work/lib", branch: "trunk" }] };

/** Opens the dialog from the menu of the sidebar's list of worktrees. */
async function openRepos(page: Page): Promise<Locator> {
  await (await sidebar(page)).getByRole("button", { name: /^リポジトリで絞り込む/ }).click();
  await page.getByRole("menuitem", { name: "リポジトリを登録・解除…" }).click();
  const dialog = page.getByRole("dialog", { name: "リポジトリの登録" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const registers = (d: { received: { type: string }[] }) => d.received.filter((m) => m.type === "repo.register");

test("候補から登録すると、一覧に出て候補から消え、サイドバーにその worktree が出る", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({
    name: "mac",
    capabilities: { folderRepos: [{ path: "/work/app", worktreeCount: 2 }, { path: "/work/lib", worktreeCount: 1 }] },
  });
  daemon.handle("repo.register", (msg) => {
    daemon.setRepos([...daemon.repos, msg.path === APP.path ? APP : LIB]);
    return commandResult(msg, { ok: true, path: msg.path });
  });
  await openHome(page, 1);
  const mac = (await openRepos(page)).getByRole("region", { name: "mac" });
  await expect(mac.getByText("登録したリポジトリはありません。")).toBeVisible();
  const list = mac.getByRole("listbox", { name: "mac に登録するリポジトリ" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list.getByRole("option").first()).toContainText("/work/app");
  await expect(list.getByRole("option").first()).toContainText("worktree 2");

  const search = mac.getByRole("combobox", { name: "mac に登録するリポジトリ" });
  await search.fill("zzz");
  await expect(list.getByText("一致するリポジトリはありません。")).toBeVisible();
  await search.fill("ap");
  await expect(list.getByRole("option")).toHaveCount(1);
  await list.getByRole("option", { name: /app/ }).click();

  await expect(mac.getByText("登録しました：/work/app")).toBeVisible();
  const registered = mac.getByRole("listitem");
  await expect(registered).toHaveCount(1);
  await expect(registered).toContainText("app · worktree 2");
  await expect(registered).toContainText("/work/app");
  await search.fill("");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option")).toContainText("/work/lib");
  expect(registers(daemon)).toEqual([expect.objectContaining({ path: "/work/app" })]);

  await page.getByRole("dialog", { name: "リポジトリの登録" }).getByRole("button", { name: "閉じる" }).click();
  const bar = await sidebar(page);
  await expect(bar.getByRole("button", { name: /^main/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^feat/ })).toBeVisible();
});

test("一覧に無いフォルダーを入れて登録する。絶対パスでないとそう出す", async ({ page, hub }) => {
  // Without folderRepos: a gasho-daemon too old to offer the repositories.
  const daemon = await hub.fakeDaemon({ name: "mac" });
  daemon.handle("repo.register", (msg) => {
    daemon.setRepos([{ path: "/work/x", worktrees: [{ path: "/work/x", branch: "main" }, { path: "/work/x-wt", branch: "wt" }] }]);
    // A worktree's folder registers its repository.
    return commandResult(msg, { ok: true, path: "/work/x" });
  });
  await openHome(page, 1);
  const mac = (await openRepos(page)).getByRole("region", { name: "mac" });
  await expect(mac.getByText(/^この working server の gasho-daemon は古いため、リポジトリの候補を出せません。/)).toBeVisible();
  const field = mac.getByLabel(/^一覧に無いフォルダーを登録する/);
  const submit = mac.getByRole("button", { name: "登録する" });
  await expect(submit).toBeDisabled();

  await field.fill("work/x");
  await submit.click();
  await expect(mac.getByRole("alert")).toHaveText("フォルダーを絶対パスで入れてください。");
  expect(registers(daemon)).toHaveLength(0);

  await field.fill("/work/x-wt");
  await field.press("Enter");
  await expect(mac.getByText("登録しました：/work/x")).toBeVisible();
  await expect(mac.getByRole("alert")).toHaveCount(0);
  await expect(field).toHaveValue("");
  await expect(mac.getByRole("listitem")).toContainText("x · worktree 2");
  expect(registers(daemon)).toEqual([expect.objectContaining({ path: "/work/x-wt" })]);
});

test("登録できないと、gasho-daemon が答えた理由を出す", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({ name: "mac" });
  const answer = deferred();
  daemon.handle("repo.register", async (msg) => {
    await answer.promise;
    return commandResult(msg, { ok: false, error: "git のリポジトリではありません。" });
  });
  await openHome(page, 1);
  const mac = (await openRepos(page)).getByRole("region", { name: "mac" });
  const field = mac.getByLabel(/^一覧に無いフォルダーを登録する/);
  await field.fill("/tmp/nope");
  await mac.getByRole("button", { name: "登録する" }).click();
  await expect(field).toBeDisabled();
  answer.resolve();
  await expect(mac.getByRole("alert")).toHaveText("git のリポジトリではありません。");
  await expect(field).toHaveValue("/tmp/nope");
  await expect(mac.getByText("登録したリポジトリはありません。")).toBeVisible();
});

test("登録したリポジトリと読めないリポジトリの理由を出し、「解除」で外す。外せないと理由を出す", async ({ page, hub }) => {
  const gone: RegisteredRepo = { path: "/work/gone", worktrees: [], error: "フォルダーがありません。" };
  const daemon = await hub.fakeDaemon({ name: "mac", repos: [APP, gone] });
  const answer = deferred();
  daemon.handle("repo.unregister", async (msg) => {
    if (msg.path === gone.path) return commandResult(msg, { ok: false, error: "repos.json に書けませんでした。" });
    await answer.promise;
    daemon.setRepos(daemon.repos.filter((r) => r.path !== msg.path));
    return commandResult(msg, { ok: true });
  });
  await openHome(page, 1);
  await expect((await sidebar(page)).getByRole("button", { name: /^feat/ })).toBeVisible();
  const dialog = await openRepos(page);
  const mac = dialog.getByRole("region", { name: "mac" });
  const app = mac.getByRole("listitem").filter({ hasText: "/work/app" });
  const broken = mac.getByRole("listitem").filter({ hasText: "/work/gone" });
  await expect(app).toContainText("app · worktree 2");
  await expect(broken).toContainText("gone · worktree 0");
  await expect(broken).toContainText("フォルダーがありません。");

  await app.getByRole("button", { name: "解除" }).click();
  await expect(app.getByRole("button", { name: "解除しています…" })).toBeDisabled();
  await expect(broken.getByRole("button", { name: "解除" })).toBeDisabled();
  answer.resolve();
  await expect(app).toHaveCount(0);
  await broken.getByRole("button", { name: "解除" }).click();
  await expect(mac.getByRole("alert")).toHaveText("repos.json に書けませんでした。");
  await expect(broken).toBeVisible();

  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect((await sidebar(page)).getByRole("button", { name: /^feat/ })).toHaveCount(0);
});

test("working server ごとに、候補が無い理由と、オフラインであることを出す", async ({ page, hub }) => {
  await hub.fakeDaemon({ name: "mac", capabilities: { folderRepos: [{ path: "/work/app", worktreeCount: 2 }] }, repos: [APP] });
  await hub.fakeDaemon({ name: "linux", capabilities: { folderRepos: [] } });
  const away = await hub.fakeDaemon({ name: "away", repos: [LIB] });
  await away.disconnect();
  await openHome(page, 3);
  const dialog = await openRepos(page);

  await expect(dialog.getByRole("region", { name: "mac" }).getByText("Claude Code が信頼しているフォルダーのリポジトリは、すべて登録してあります。")).toBeVisible();
  const linux = dialog.getByRole("region", { name: "linux" });
  await expect(linux.getByText("登録したリポジトリはありません。")).toBeVisible();
  await expect(linux.getByText("Claude Code が信頼しているフォルダーに、git のリポジトリはありません。")).toBeVisible();
  // Offline, what it had registered stays listed, and nothing can be registered or taken off.
  const offline = dialog.getByRole("region", { name: "away" });
  await expect(offline.getByText("オフライン", { exact: true })).toBeVisible();
  await expect(offline.getByRole("listitem")).toContainText("lib · worktree 1");
  await expect(offline.getByRole("button", { name: "解除" })).toBeDisabled();
  await expect(offline.getByText("登録するリポジトリ")).toHaveCount(0);
});

test("スマホで、リポジトリの登録のダイアログを Esc で閉じても、ドロワーは開いたまま", async ({ page, hub, isMobile }) => {
  test.skip(!isMobile, "ドロワーはスマホの幅だけ");
  test.fail(true, "#183: ドロワーが Esc を window の keydown で受けるので、ダイアログを閉じた Esc でドロワーも閉じる");
  await hub.fakeDaemon({ name: "mac" });
  await openHome(page, 1);
  const dialog = await openRepos(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // A closing drawer still shows while it slides out; what is pressed in it then leaves the page.
  const drawer = page.getByRole("dialog", { name: "サイドバー" });
  await drawer.getByRole("button", { name: "ホーム", exact: true }).click({ timeout: 10_000 });
  await expect(drawer).toBeHidden();
});

test("#108: 候補の絞り込みで、変換を確定する Enter では登録しない", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({
    name: "mac",
    capabilities: { folderRepos: [{ path: "/work/app", worktreeCount: 2 }, { path: "/work/lib", worktreeCount: 1 }] },
  });
  daemon.handle("repo.register", (msg) => commandResult(msg, { ok: false, error: `${msg.path} は登録しません。` }));
  await openHome(page, 1);
  const mac = (await openRepos(page)).getByRole("region", { name: "mac" });
  const search = mac.getByRole("combobox", { name: "mac に登録するリポジトリ" });
  await search.fill("ap");
  await confirmConversion(search);
  await search.fill("lib");
  await search.press("Enter");
  await expect(mac.getByRole("alert")).toHaveText("/work/lib は登録しません。");
  expect(registers(daemon)).toEqual([expect.objectContaining({ path: "/work/lib" })]);
});

test("フォルダーの中に複数のリポジトリがあるセッションは、「複数のリポジトリ…」でそれぞれを出す", async ({ page, hub }) => {
  const sessionId = randomUUID();
  const daemon = await hub.fakeDaemon({
    name: "mac",
    sessions: [
      fakeSession({
        sessionId,
        cwd: "/work/space",
        name: "e2e-space",
        repos: [
          { path: "app", branch: "main", github: { owner: "octo", name: "app", url: "https://github.com/octo/app" } },
          { path: "tools/lib", branch: "dev" },
        ],
      }),
    ],
  });
  await openHome(page, 1);
  await page.goto(`/#/s/${encodeURIComponent(daemon.machineId)}/${sessionId}`);
  await expect(page.getByPlaceholder("Agent への指示を入力…")).toBeVisible();
  // A phone opens a session with its header closed.
  await showHeader(page);

  await page.getByRole("button", { name: "複数のリポジトリ…" }).click();
  const popup = page.getByRole("dialog").filter({ hasText: "リポジトリ（2）" });
  await expect(popup).toBeVisible();
  const app = popup.getByRole("link", { name: /app/ });
  await expect(app).toHaveAttribute("href", "https://github.com/octo/app");
  await expect(app).toHaveAttribute("target", "_blank");
  await expect(app).toContainText("octo/app · main");
  await expect(popup.getByText("tools/lib", { exact: true })).toBeVisible();
  await expect(popup.getByText("GitHub なし")).toBeVisible();
  await expect(popup.getByText("dev", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
});
