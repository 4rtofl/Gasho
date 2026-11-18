// Cloning a repository from the button beside the menu of the sidebar's list of worktrees: with this checkout's
// gasho-daemon and a gh that makes a repository, what the sidebar then lists, which working server it lands on, and
// what is said when it cannot be done. Then, with fake daemons, the wait and a clone that cannot be registered.
import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RegisteredRepo } from "@gasho/protocol";
import { commandResult, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { deferred, openHome, sidebar } from "./launch-helpers.ts";
import { routeConnection } from "./screen.ts";

const TITLE = "リポジトリを clone";
const OTHER_FOLDER = "ほかのフォルダーを入力する…";
const LIB: RegisteredRepo = { path: "/work/lib", worktrees: [{ path: "/work/lib", branch: "trunk" }] };

/** Opens the dialog from the sidebar (on a phone, from its drawer). */
async function openClone(page: Page): Promise<Locator> {
  await (await sidebar(page)).getByRole("button", { name: TITLE, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function fill(dialog: Locator, o: { repo: string; folder?: string; name?: string; server?: string }): Promise<void> {
  if (o.server) await dialog.getByRole("combobox", { name: "working server" }).selectOption({ label: o.server });
  await dialog.getByRole("textbox", { name: "clone するリポジトリ" }).fill(o.repo);
  if (o.folder) {
    await dialog.getByRole("combobox", { name: "clone 先のフォルダー" }).selectOption({ label: OTHER_FOLDER });
    await dialog.getByRole("textbox", { name: "clone 先のフォルダーの絶対パス" }).fill(o.folder);
  }
  if (o.name) await dialog.getByRole("textbox", { name: "フォルダーの名前（任意）" }).fill(o.name);
}

const press = (dialog: Locator) => dialog.getByRole("button", { name: "clone する", exact: true }).click();

/**
 * A gasho-daemon of this checkout whose gh makes a repository with one commit on main, and writes down what it was
 * asked. `owner/missing` is a repository GitHub does not have.
 */
async function realDaemon(hub: GashoHub, name: string): Promise<{ asked: () => Promise<string> }> {
  const log = path.join(hub.root, `${name}-gh.log`);
  const gh = path.join(hub.root, `${name}-gh`);
  await fs.writeFile(
    gh,
    `#!/bin/sh
[ "$1 $2" = "repo clone" ] || exit 0
echo "$3 $4" >> "${log}"
if [ "$3" = owner/missing ]; then echo "GraphQL: Could not resolve to a Repository with the name 'owner/missing'." >&2; exit 1; fi
git init -q -b main "$4" && git -C "$4" -c user.name=e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m first
`,
    { mode: 0o755 },
  );
  await hub.startDaemon({ name, env: { GASHO_GH_BIN: gh } });
  return { asked: () => fs.readFile(log, "utf8").catch(() => "") };
}

test("clone すると登録され、選んだ working server のリポジトリとしてサイドバーに出る", async ({ page, hub }) => {
  test.slow();
  const first = await realDaemon(hub, "first");
  const second = await realDaemon(hub, "second");
  const parent = path.join(hub.home, "code");
  await fs.mkdir(parent);
  await openHome(page, 2);

  const dialog = await openClone(page);
  await fill(dialog, { server: "second", repo: "https://github.com/owner/tool.git", folder: parent });
  await expect(dialog.getByText(path.join(parent, "tool"), { exact: true })).toBeVisible();
  await press(dialog);

  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect((await sidebar(page)).getByRole("button", { name: /^main/ })).toBeVisible({ timeout: 30_000 });
  await fs.access(path.join(parent, "tool", ".git"));
  expect(await second.asked()).toBe("https://github.com/owner/tool.git tool\n");
  expect(await first.asked()).toBe("");
});

test("無いフォルダー、すでにある名前、間違ったリポジトリでは、理由を出して何も変えない", async ({ page, hub }) => {
  test.slow();
  const daemon = await realDaemon(hub, "only");
  const parent = path.join(hub.home, "code");
  await fs.mkdir(path.join(parent, "taken"), { recursive: true });
  await fs.writeFile(path.join(parent, "taken", "keep.txt"), "keep");
  await openHome(page, 1);
  const dialog = await openClone(page);
  const alert = dialog.getByRole("alert");

  await fill(dialog, { repo: "not a repo", folder: parent });
  await press(dialog);
  await expect(alert).toContainText("owner/name");

  await fill(dialog, { repo: "owner/tool", folder: path.join(hub.home, "nowhere") });
  await press(dialog);
  await expect(alert).toContainText("フォルダーがありません");

  await fill(dialog, { repo: "owner/tool", folder: parent, name: "taken" });
  await press(dialog);
  await expect(alert).toContainText("すでにあります");

  await dialog.getByRole("textbox", { name: "フォルダーの名前（任意）" }).fill("");
  await fill(dialog, { repo: "owner/missing", folder: parent });
  await press(dialog);
  await expect(alert).toContainText("GitHub にこのリポジトリが見つかりません");

  await expect(dialog).toBeVisible();
  expect(await fs.readdir(parent)).toEqual(["taken"]);
  expect(await fs.readFile(path.join(parent, "taken", "keep.txt"), "utf8")).toBe("keep");
  // Only the repository that passed every check reached gh.
  expect(await daemon.asked()).toBe("owner/missing missing\n");
  await expect((await sidebar(page)).getByRole("button", { name: /^main/ })).toHaveCount(0);
});

test("信頼済みのフォルダーとその親を候補に出し、clone のあいだは閉じられない", async ({ page, hub, isMobile }) => {
  const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/home/me/repos/app"] } });
  const answer = deferred();
  daemon.handle("repo.clone", async (msg) => {
    await answer.promise;
    return commandResult(msg, { ok: true, path: `${msg.parent}/${msg.name ?? "lib"}` });
  });
  daemon.handle("repo.register", (msg) => {
    daemon.setRepos([{ ...LIB, path: msg.path }]);
    return commandResult(msg, { ok: true, path: msg.path });
  });
  await openHome(page, 1);
  const dialog = await openClone(page);
  await expect(dialog.getByRole("combobox", { name: "clone 先のフォルダー" }).locator("option")).toHaveText(["/home/me/repos", "/home/me/repos/app", OTHER_FOLDER]);
  await fill(dialog, { repo: "owner/lib" });
  await expect(dialog.getByText("/home/me/repos/lib", { exact: true })).toBeVisible();
  await press(dialog);

  await expect(dialog.getByRole("status")).toContainText("最長 10 分");
  await expect(dialog.getByRole("button", { name: "閉じる" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "やめる" })).toBeDisabled();
  // On a phone, Esc would close the drawer behind the dialog too (#183).
  if (!isMobile) await page.keyboard.press("Escape");
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();

  answer.resolve();
  await expect(dialog).toBeHidden();
  await expect((await sidebar(page)).getByRole("button", { name: /^trunk/ })).toBeVisible();
});

test("clone できて登録できないと、clone 先と理由を出す", async ({ page, hub }) => {
  const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/home/me/repos/app"] } });
  daemon.handle("repo.clone", (msg) => commandResult(msg, { ok: true, path: "/home/me/repos/lib" }));
  daemon.handle("repo.register", (msg) => commandResult(msg, { ok: false, error: "登録先に書き込めません。" }));
  await openHome(page, 1);
  const dialog = await openClone(page);
  await fill(dialog, { repo: "owner/lib" });
  await press(dialog);
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("clone できましたが、登録できませんでした");
  await expect(alert).toContainText("/home/me/repos/lib");
  await expect(alert).toContainText("登録先に書き込めません。");
  await dialog.getByRole("button", { name: "閉じる" }).last().click();
  await expect(dialog).toBeHidden();
});

test("clone の途中で接続が切れると、結果が分からないことと clone 先を出し、閉じられる", async ({ page, hub }) => {
  const conn = await routeConnection(page);
  const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/home/me/repos/app"] } });
  const answer = deferred();
  daemon.handle("repo.clone", async (msg) => {
    await answer.promise;
    return commandResult(msg, { ok: true, path: "/home/me/repos/lib" });
  });
  await openHome(page, 1);
  const dialog = await openClone(page);
  await fill(dialog, { repo: "owner/lib" });
  await press(dialog);
  await expect(dialog.getByRole("status")).toContainText("最長 10 分");
  await expect.poll(() => daemon.received.some((m) => m.type === "repo.clone")).toBe(true);

  await conn.drop();
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText("clone できたか分かりません");
  await expect(alert).toContainText("/home/me/repos/lib");
  await expect(alert).toContainText("「リポジトリを登録・解除…」");

  // The working server finishes after the page has connected again: nothing is registered behind the person's back.
  await expect.poll(() => conn.made).toBeGreaterThan(1);
  answer.resolve();
  await expect(alert).toBeVisible();
  expect(daemon.received.filter((m) => m.type === "repo.register")).toEqual([]);
  await dialog.getByRole("button", { name: "閉じる" }).last().click();
  await expect(dialog).toBeHidden();
});

test("ほかのリポジトリに絞り込んでいても、clone したリポジトリが一覧に出る", async ({ page, hub, isMobile }) => {
  test.skip(isMobile, "絞り込みのメニューを閉じる Esc は、スマホではドロワーも閉じる（#183）");
  const app: RegisteredRepo = { path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] };
  const daemon = await hub.fakeDaemon({ name: "mac", repos: [app], capabilities: { folders: ["/work/app"] } });
  daemon.handle("repo.clone", (msg) => commandResult(msg, { ok: true, path: LIB.path }));
  daemon.handle("repo.register", (msg) => {
    daemon.setRepos([app, LIB]);
    return commandResult(msg, { ok: true, path: msg.path });
  });
  await openHome(page, 1);
  const bar = await sidebar(page);
  await bar.getByRole("button", { name: /^リポジトリで絞り込む/ }).click();
  await page.getByRole("menuitemcheckbox", { name: "app" }).click();
  await page.keyboard.press("Escape");
  await expect(bar.getByText("worktree · app")).toBeVisible();

  const dialog = await openClone(page);
  await fill(dialog, { repo: "owner/lib", folder: "/work" });
  await press(dialog);
  await expect(dialog).toBeHidden();
  await expect(bar.getByRole("button", { name: /^trunk/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^main/ })).toBeVisible();
});
