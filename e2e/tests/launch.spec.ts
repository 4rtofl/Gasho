// Starting a new session from the form, on the home screen (under "新しいセッション") and in the dialog of the sidebar's
// "新しいセッション", which the plugin's session list brings: the working servers it offers, the folder, the name, a new
// folder and a clone, what an older gasho-daemon lacks, the wait, a folder Claude Code does not trust yet, and a start
// with a warning. Then what only the dialog does, and the dialog a category's "＋" opens when it could not start.
import type { Locator, Page } from "@playwright/test";
import { commandResult, type FakeDaemon, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { CATEGORIES_PLUGIN, confirmConversion, deferred, expectSessionOpen, launches, openHome, pressInSidebar, sidebar, started } from "./launch-helpers.ts";

test.use({ hubOptions: { plugins: [CATEGORIES_PLUGIN] } });

const TITLE = "新しいセッションを起動する";
const LAUNCH = { name: "起動する", exact: true } as const;

interface Surface {
  name: string;
  /** Opens the form once the home screen tells `machines` working servers, and gives what holds it. */
  open: (page: Page, machines: number) => Promise<Locator>;
}

const SURFACES: Surface[] = [
  {
    name: "ホームのパネル",
    open: async (page, machines) => {
      await openHome(page, machines);
      await page.getByRole("main").getByRole("button", { name: "新しいセッション", exact: true }).click();
      await expect(page.getByRole("main").getByRole("heading", { name: TITLE })).toBeVisible();
      return page.getByRole("main");
    },
  },
  {
    name: "サイドバーのダイアログ",
    open: async (page, machines) => {
      await openHome(page, machines);
      await pressInSidebar(page, "新しいセッション");
      const dialog = page.getByRole("dialog", { name: TITLE });
      await expect(dialog).toBeVisible();
      return dialog;
    },
  },
];

/** The form has gone: the panel or the dialog closed once the session started. */
const expectFormClosed = (page: Page) => expect(page.getByText(TITLE, { exact: true })).toHaveCount(0);

for (const surface of SURFACES) {
  test.describe(surface.name, () => {
    test("起動できる working server が無いと、そう出て、起動のボタンが無い", async ({ page, hub }) => {
      await hub.fakeDaemon({ name: "mac", capabilities: { canLaunch: false } });
      const form = await surface.open(page, 1);
      await expect(form.getByText(/^起動できる working server がありません。/)).toBeVisible();
      await expect(form.getByRole("button", LAUNCH)).toHaveCount(0);
    });

    test("セッションの端末を作れない working server と、オフラインの working server は選べない", async ({ page, hub }) => {
      await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      await hub.fakeDaemon({ name: "linux", capabilities: { canLaunch: false } });
      const away = await hub.fakeDaemon({ name: "away" });
      await away.disconnect();
      const form = await surface.open(page, 3);
      await expect(form.getByRole("combobox", { name: "working server" }).locator("option")).toHaveText(["mac"]);
    });

    test("選んだフォルダーと名前（60 文字まで）で起動し、待つあいだはそう出て、セッションが開く", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a", "/work/b"] } });
      const answer = deferred();
      daemon.handle("session.launch", async (msg) => {
        await answer.promise;
        return started(daemon, msg);
      });
      const form = await surface.open(page, 1);
      await expect(form.getByRole("combobox", { name: "working server" })).toHaveValue(daemon.machineId);
      const folder = form.getByRole("combobox", { name: "フォルダー", exact: true });
      await expect(folder).toHaveValue("/work/a");
      await expect(folder.locator("option")).toHaveText(["/work/a", "/work/b", "ほかのフォルダーを入力する…"]);
      await folder.selectOption("/work/b");
      const name = form.getByLabel(/^名前/);
      // gasho-daemon 0.10.0 and later name a session started without one after its first message.
      await expect(name).toHaveAttribute("placeholder", "空なら、最初のメッセージから付けます");
      const long = "e2e-name-".repeat(7);
      await name.pressSequentially(long);
      await expect(name).toHaveValue(long.slice(0, 60));

      await form.getByRole("button", LAUNCH).click();
      await expect(form.getByRole("button", { name: "起動しています…（最大30秒）" })).toBeDisabled();
      await expect(folder).toBeDisabled();
      answer.resolve();
      await expectSessionOpen(page, daemon, "/work/b");
      await expectFormClosed(page);
      expect(launches(daemon)).toEqual([expect.objectContaining({ cwd: "/work/b", name: long.slice(0, 60) })]);
      expect(launches(daemon)[0]).not.toHaveProperty("trust");
    });

    test("「ほかのフォルダーを入力する…」で入れたフォルダーで起動する", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("session.launch", (msg) => started(daemon, msg));
      const form = await surface.open(page, 1);
      await form.getByRole("combobox", { name: "フォルダー", exact: true }).selectOption({ label: "ほかのフォルダーを入力する…" });
      const custom = form.getByPlaceholder("/home/rg/repos/…（絶対パス）");
      await expect(custom).toBeVisible();
      await expect(form.getByRole("button", LAUNCH)).toBeDisabled();
      await custom.fill("/srv/other");
      await form.getByRole("button", LAUNCH).click();
      await expectSessionOpen(page, daemon, "/srv/other");
      expect(launches(daemon)).toHaveLength(1);
      // Without a name, none is sent: gasho-daemon names the session after its first message.
      expect(launches(daemon)[0]).not.toHaveProperty("name");
    });

    test("「新しいフォルダー」で作ったフォルダーが選ばれ、そこで起動する", async ({ page, hub }) => {
      // A folder three levels down is offered with the folder that holds it, where a new folder or a clone can go.
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/home/me/repos/a"] } });
      const made = deferred();
      daemon.handle("folder.create", async (msg) => {
        await made.promise;
        return commandResult(msg, { ok: true, path: `${msg.parent}/${msg.name}` });
      });
      daemon.handle("session.launch", (msg) => started(daemon, msg));
      const form = await surface.open(page, 1);
      const folder = form.getByRole("combobox", { name: "フォルダー", exact: true });
      await expect(folder.locator("option")).toHaveText(["/home/me/repos", "/home/me/repos/a", "ほかのフォルダーを入力する…"]);
      await folder.selectOption("/home/me/repos");

      const tool = form.getByRole("button", { name: "新しいフォルダー" });
      await tool.click();
      await expect(tool).toHaveAttribute("aria-expanded", "true");
      const field = form.getByLabel("選んだフォルダーの中に作るフォルダーの名前");
      await expect(field).toBeFocused();
      await field.fill("ws");
      await expect(form.getByText("/home/me/repos/ws", { exact: true })).toBeVisible();
      await form.getByRole("button", { name: "作る", exact: true }).click();
      await expect(form.getByRole("button", { name: "作っています…" })).toBeDisabled();
      await expect(form.getByRole("button", LAUNCH)).toBeDisabled();
      made.resolve();

      await expect(form.getByText("フォルダーを作って、選びました")).toBeVisible();
      await expect(folder).toHaveValue("/home/me/repos/ws");
      await expect(field).toBeHidden();
      await expect(tool).toHaveAttribute("aria-expanded", "false");
      expect(await daemon.waitFor("folder.create")).toMatchObject({ parent: "/home/me/repos", name: "ws" });
      await form.getByRole("button", LAUNCH).click();
      await expectSessionOpen(page, daemon, "/home/me/repos/ws");
    });

    test("新しいフォルダーの名前が正しくないとき・作れなかったときは、理由を出す", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("folder.create", (msg) => commandResult(msg, { ok: false, error: "同じ名前のフォルダーがすでにあります。" }));
      const form = await surface.open(page, 1);
      await form.getByRole("button", { name: "新しいフォルダー" }).click();
      const field = form.getByLabel("選んだフォルダーの中に作るフォルダーの名前");
      const make = form.getByRole("button", { name: "作る", exact: true });
      await expect(make).toBeDisabled();

      await field.fill("a/b");
      await make.click();
      await expect(form.getByText("フォルダーの名前に / は使えません。")).toBeVisible();
      await field.fill("-x");
      // What was wrong goes once the name is changed.
      await expect(form.getByText("フォルダーの名前に / は使えません。")).toHaveCount(0);
      await make.click();
      await expect(form.getByText("「-」で始まる名前は使えません。")).toBeVisible();
      expect(daemon.received.filter((m) => m.type === "folder.create")).toHaveLength(0);

      await field.fill("a");
      await make.click();
      await expect(form.getByText("同じ名前のフォルダーがすでにあります。")).toBeVisible();
      await expect(form.getByRole("combobox", { name: "フォルダー", exact: true })).toHaveValue("/work/a");
      expect(daemon.received.filter((m) => m.type === "folder.create")).toEqual([expect.objectContaining({ parent: "/work/a", name: "a" })]);
    });

    test("新しいフォルダーの名前の欄の Enter で作り、変換を確定する Enter では作らない", async ({ page, hub }) => {
      const daemon = await newFolderDaemon(hub);
      const form = await surface.open(page, 1);
      await form.getByRole("button", { name: "新しいフォルダー" }).click();
      const field = form.getByLabel("選んだフォルダーの中に作るフォルダーの名前");
      await field.fill("へんかん");
      await confirmConversion(field);
      await field.fill("ws");
      await field.press("Enter");
      await expect(form.getByText("フォルダーを作って、選びました")).toBeVisible();
      expect(names(daemon, "folder.create")).toEqual(["ws"]);
    });

    test("#108: Safari の、変換を確定する Enter（keyCode 229）では、フォルダーを作らない", async ({ page, hub }) => {
      const daemon = await newFolderDaemon(hub);
      const form = await surface.open(page, 1);
      await form.getByRole("button", { name: "新しいフォルダー" }).click();
      const field = form.getByLabel("選んだフォルダーの中に作るフォルダーの名前");
      await field.fill("へんかん");
      await confirmConversion(field, "safari");
      await field.fill("ws");
      await field.press("Enter");
      await expect(form.getByText("フォルダーを作って、選びました")).toBeVisible();
      expect(names(daemon, "folder.create")).toEqual(["ws"]);
    });

    test("GitHub から clone したフォルダーを「このフォルダーを選ぶ」で選び、そこで起動する", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/home/me/repos/a"] } });
      const cloned = deferred();
      daemon.handle("repo.clone", async (msg) => {
        await cloned.promise;
        return commandResult(msg, { ok: true, path: `${msg.parent}/hello` });
      });
      daemon.handle("session.launch", (msg) => started(daemon, msg));
      const form = await surface.open(page, 1);
      const folder = form.getByRole("combobox", { name: "フォルダー", exact: true });
      await folder.selectOption("/home/me/repos");

      await form.getByRole("button", { name: "GitHub から clone" }).click();
      const repo = form.getByLabel("リポジトリ（owner/name か、GitHub の URL）");
      await expect(repo).toBeFocused();
      await repo.fill("octo/hello");
      await expect(form.getByLabel(/^フォルダーの名前（任意/)).toHaveAttribute("placeholder", "hello");
      await expect(form.getByText("/home/me/repos/hello", { exact: true })).toBeVisible();
      await form.getByRole("button", { name: "clone する", exact: true }).click();
      await expect(form.getByRole("button", { name: "clone しています…" })).toBeDisabled();
      await expect(form.getByRole("button", LAUNCH)).toBeDisabled();
      cloned.resolve();

      await expect(form.getByText("octo/hello を clone しました")).toBeVisible();
      // A clone leaves the folder chosen as it was, for more clones next to it, and offers the new one.
      await expect(folder).toHaveValue("/home/me/repos");
      await expect(repo).toHaveValue("");
      const msg = await daemon.waitFor("repo.clone");
      expect(msg).toMatchObject({ parent: "/home/me/repos", repo: "octo/hello" });
      expect(msg).not.toHaveProperty("name");
      await form.getByRole("button", { name: "このフォルダーを選ぶ" }).click();
      await expect(folder).toHaveValue("/home/me/repos/hello");
      await expect(form.getByRole("button", { name: "このフォルダーを選ぶ" })).toHaveCount(0);
      await expect(repo).toBeHidden();
      await form.getByRole("button", LAUNCH).click();
      await expectSessionOpen(page, daemon, "/home/me/repos/hello");
    });

    test("GitHub の URL と clone 先の名前で clone する。指定が正しくないとき・clone できなかったときは、理由を出す", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("repo.clone", (msg) => commandResult(msg, { ok: false, error: "gh にログインしていません。" }));
      const form = await surface.open(page, 1);
      await form.getByRole("button", { name: "GitHub から clone" }).click();
      const repo = form.getByLabel("リポジトリ（owner/name か、GitHub の URL）");
      const as = form.getByLabel(/^フォルダーの名前（任意/);
      const clone = form.getByRole("button", { name: "clone する", exact: true });
      await expect(clone).toBeDisabled();

      await repo.fill("octo/hello world");
      await clone.click();
      await expect(form.getByText("リポジトリは「owner/name」か、GitHub のリポジトリの URL で指定してください。")).toBeVisible();
      await repo.fill("https://github.com/octo/hello.git");
      await expect(as).toHaveAttribute("placeholder", "hello");
      await as.fill("a/b");
      await clone.click();
      await expect(form.getByText("フォルダーの名前に / は使えません。")).toBeVisible();
      expect(daemon.received.filter((m) => m.type === "repo.clone")).toHaveLength(0);

      await as.fill("hello-2");
      await expect(form.getByText("/work/a/hello-2", { exact: true })).toBeVisible();
      await clone.click();
      await expect(form.getByText("gh にログインしていません。")).toBeVisible();
      expect(await daemon.waitFor("repo.clone")).toMatchObject({ parent: "/work/a", repo: "https://github.com/octo/hello.git", name: "hello-2" });
    });

    test("clone の 2 つの欄の Enter で clone し、変換を確定する Enter では clone しない", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("repo.clone", (msg) => commandResult(msg, { ok: true, path: `${msg.parent}/${msg.name ?? msg.repo.split("/").pop()}` }));
      const form = await surface.open(page, 1);
      await form.getByRole("button", { name: "GitHub から clone" }).click();
      const repo = form.getByLabel("リポジトリ（owner/name か、GitHub の URL）");
      const as = form.getByLabel(/^フォルダーの名前（任意/);

      await repo.fill("octo/first");
      await confirmConversion(repo);
      await repo.fill("octo/hello");
      await repo.press("Enter");
      await expect(form.getByText("octo/hello を clone しました")).toBeVisible();

      await repo.fill("octo/second");
      await as.fill("へんかん");
      await confirmConversion(as);
      await as.fill("second-2");
      await as.press("Enter");
      await expect(form.getByText("octo/second を clone しました")).toBeVisible();
      expect(daemon.received.filter((m) => m.type === "repo.clone")).toEqual([
        expect.objectContaining({ repo: "octo/hello" }),
        expect.objectContaining({ repo: "octo/second", name: "second-2" }),
      ]);
    });

    test("gasho-daemon が 0.10 より古いと、フォルダーの作成と clone を出さず、そう出す", async ({ page, hub }) => {
      await hub.fakeDaemon({ name: "old", version: "0.9.0", capabilities: { folders: ["/home/me/repos/a"] } });
      const form = await surface.open(page, 1);
      await expect(form.getByText("フォルダーの作成と clone は、old の gasho-daemon を 0.10.0 以上に更新すると使えます。")).toBeVisible();
      await expect(form.getByRole("button", { name: "新しいフォルダー" })).toHaveCount(0);
      await expect(form.getByRole("button", { name: "GitHub から clone" })).toHaveCount(0);
      // Only the folders Claude Code trusts: an older gasho-daemon cannot answer whether to trust another.
      await expect(form.getByRole("combobox", { name: "フォルダー", exact: true }).locator("option")).toHaveText(["/home/me/repos/a", "ほかのフォルダーを入力する…"]);
      await expect(form.getByText(/^一覧に出るのは、Claude Code がすでに信頼しているフォルダーです。/)).toBeVisible();
      await expect(form.getByLabel(/^名前/)).toHaveAttribute("placeholder", "例：Bobert の調査");
    });

    test("起動の答えが来ないと、時間切れの文を出し、もう一度起動できる", async ({ page, hub }) => {
      await page.clock.install();
      const pings = unanswered(page);
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      let answers = false;
      daemon.handle("session.launch", (msg) => (answers ? started(daemon, msg) : undefined));
      const form = await surface.open(page, 1);
      await form.getByRole("button", LAUNCH).click();
      await expect(form.getByRole("button", { name: "起動しています…（最大30秒）" })).toBeVisible();
      await daemon.waitFor("session.launch");
      // The screen gives up after 60 s. Meanwhile it pings every 25 s, and makes the connection again when 8 s go by
      // without the answer: the clock goes on in short steps, each once the pings sent so far are answered.
      for (let i = 0; i < 30; i++) {
        await page.clock.fastForward(2_000);
        await expect.poll(pings).toBe(0);
      }
      await expect(form.getByText("応答がありませんでした。")).toBeVisible();

      answers = true;
      await form.getByRole("button", LAUNCH).click();
      await expectSessionOpen(page, daemon, "/work/a");
    });

    test("まだ信頼していないフォルダーでは注意を出し、「やめる」で戻り、「信頼して起動する」で起動する", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("session.launch", (msg) =>
        msg.trust ? started(daemon, msg) : commandResult(msg, { ok: false, needsTrust: true, trustWarnings: ["このフォルダーの .mcp.json に MCP サーバーがあります。"] }),
      );
      const form = await surface.open(page, 1);
      const ask = form.getByRole("region", { name: "このフォルダーは、まだ Claude Code に信頼されていません" });
      await form.getByRole("button", LAUNCH).click();
      await expect(ask).toBeVisible();
      await expect(ask.getByText("/work/a", { exact: true })).toBeVisible();
      await expect(ask.getByText("Claude Code からの注意")).toBeVisible();
      await expect(ask.getByText("このフォルダーの .mcp.json に MCP サーバーがあります。")).toBeVisible();
      await expect(ask.getByRole("button", { name: "やめる" })).toBeFocused();

      await ask.getByRole("button", { name: "やめる" }).click();
      await expect(ask).toBeHidden();
      await form.getByRole("button", LAUNCH).click();
      await ask.getByRole("button", { name: "信頼して起動する" }).click();
      await expectSessionOpen(page, daemon, "/work/a");
      // Only "信頼して起動する" tells gasho-daemon to answer Claude Code's question with yes.
      expect(launches(daemon).map((m) => m.trust)).toEqual([undefined, undefined, true]);
    });

    test("警告つきで起動すると「起動しました。」と警告を出し、「セッションを開く」でセッションが開く", async ({ page, hub }) => {
      const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
      daemon.handle("session.launch", (msg) => started(daemon, msg, { warning: "Remote Control を有効にできませんでした。" }));
      const form = await surface.open(page, 1);
      await form.getByRole("button", LAUNCH).click();
      await expect(form.getByText("起動しました。")).toBeVisible();
      await expect(form.getByText("Remote Control を有効にできませんでした。")).toBeVisible();
      await expect(page).not.toHaveURL(/#\/s\//);
      await form.getByRole("button", { name: "セッションを開く" }).click();
      await expectSessionOpen(page, daemon, "/work/a");
      await expectFormClosed(page);
    });
  });
}

test.describe("サイドバーのダイアログだけ", () => {
  const dialogOf = (page: Page) => page.getByRole("dialog", { name: TITLE });

  test("開くと最初の欄にフォーカスし、Esc で閉じる。起動を待つあいだは閉じられない", async ({ page, hub }) => {
    const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
    const answer = deferred();
    daemon.handle("session.launch", async (msg) => {
      await answer.promise;
      return started(daemon, msg);
    });
    const dialog = await SURFACES[1]!.open(page, 1);
    await expect(dialog.getByRole("combobox", { name: "working server" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await pressInSidebar(page, "新しいセッション");
    await dialog.getByRole("button", LAUNCH).click();
    await expect(dialog.getByRole("button", { name: "起動しています…（最大30秒）" })).toBeVisible();
    // The dialog is told the form is waiting (onBusyChange) a render after the form shows it: an Esc before then closes it.
    await expect(dialog.getByRole("button", { name: "閉じる" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("button", { name: "閉じる" })).toBeDisabled();
    await expect(dialog).toBeVisible();
    answer.resolve();
    await expectSessionOpen(page, daemon, "/work/a");
    await expect(dialog).toBeHidden();
  });

  test("カテゴリーの「＋」で起動すると、ダイアログを開かずにセッションが開く", async ({ page, hub }) => {
    const daemon = await hub.fakeDaemon({ name: "mac", repos: [{ path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] }] });
    daemon.handle("session.launch", (msg) => started(daemon, msg));
    await openHome(page, 1);
    await (await sidebar(page)).getByRole("button", { name: "main で新しいセッションを起動" }).click();
    await expectSessionOpen(page, daemon, "/work/app");
    await expect(dialogOf(page)).toHaveCount(0);
  });

  test("カテゴリーの「＋」で起動できないと、その working server とフォルダーを入れたダイアログが開き、理由を出す", async ({ page, hub }) => {
    await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
    // Its folders do not list the worktree's: the form takes it as one typed in.
    const linux = await hub.fakeDaemon({
      name: "linux",
      capabilities: { folders: ["/srv/b"] },
      repos: [{ path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] }],
    });
    let fails = true;
    linux.handle("session.launch", (msg) => (fails ? commandResult(msg, { ok: false, error: "端末を作れませんでした。" }) : started(linux, msg)));
    await openHome(page, 2);
    await (await sidebar(page)).getByRole("button", { name: "main で新しいセッションを起動" }).click();

    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "working server" })).toHaveValue(linux.machineId);
    await expect(dialog.getByPlaceholder("/home/rg/repos/…（絶対パス）")).toHaveValue("/work/app");
    await expect(dialog.getByText("端末を作れませんでした。")).toBeVisible();
    fails = false;
    await dialog.getByRole("button", LAUNCH).click();
    await expectSessionOpen(page, linux, "/work/app");
    expect(launches(linux).map((m) => m.cwd)).toEqual(["/work/app", "/work/app"]);
  });

  test("カテゴリーの「＋」で信頼するかを聞かれると、ダイアログでそれを出し、信頼すると起動する", async ({ page, hub }) => {
    const daemon = await hub.fakeDaemon({
      name: "mac",
      capabilities: { folders: ["/work/app"] },
      repos: [{ path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] }],
    });
    daemon.handle("session.launch", (msg) => (msg.trust ? started(daemon, msg) : commandResult(msg, { ok: false, needsTrust: true, trustWarnings: [] })));
    await openHome(page, 1);
    await (await sidebar(page)).getByRole("button", { name: "main で新しいセッションを起動" }).click();

    const dialog = dialogOf(page);
    await expect(dialog.getByRole("combobox", { name: "フォルダー", exact: true })).toHaveValue("/work/app");
    const ask = dialog.getByRole("region", { name: "このフォルダーは、まだ Claude Code に信頼されていません" });
    await expect(ask.getByText("/work/app", { exact: true })).toBeVisible();
    await expect(ask.getByText("Claude Code からの注意")).toHaveCount(0);
    await ask.getByRole("button", { name: "信頼して起動する" }).click();
    await expectSessionOpen(page, daemon, "/work/app");
    expect(launches(daemon).map((m) => m.trust)).toEqual([undefined, true]);
  });

  test("スマホで、カテゴリーの「＋」で開いたダイアログを Esc で閉じても、ドロワーは開いたまま", async ({ page, hub, isMobile }) => {
    test.skip(!isMobile, "ドロワーはスマホの幅だけ");
    test.fail(true, "#183: ドロワーが Esc を window の keydown で受けるので、ダイアログを閉じた Esc でドロワーも閉じる");
    const daemon = await hub.fakeDaemon({ name: "mac", repos: [{ path: "/work/app", worktrees: [{ path: "/work/app", branch: "main" }] }] });
    daemon.handle("session.launch", (msg) => commandResult(msg, { ok: false, error: "端末を作れませんでした。" }));
    await openHome(page, 1);
    // Not started: the dialog opens over the drawer, which stays open.
    await (await sidebar(page)).getByRole("button", { name: "main で新しいセッションを起動" }).click();
    await expect(dialogOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialogOf(page)).toBeHidden();
    // A closing drawer still shows while it slides out; what is pressed in it then leaves the page.
    const drawer = page.getByRole("dialog", { name: "サイドバー" });
    await drawer.getByRole("button", { name: "ホーム", exact: true }).click({ timeout: 10_000 });
    await expect(drawer).toBeHidden();
  });
});

/** A working server whose gasho-daemon makes the folder "ws" in /work/a, and no other. */
async function newFolderDaemon(hub: GashoHub) {
  const daemon = await hub.fakeDaemon({ name: "mac", capabilities: { folders: ["/work/a"] } });
  daemon.handle("folder.create", (msg) =>
    commandResult(msg, msg.name === "ws" ? { ok: true, path: `${msg.parent}/ws` } : { ok: false, error: `${msg.name} は作りません。` }),
  );
  return daemon;
}

/** Counts the pings the page sends to the Gasho server, less its answers: how many have not been answered yet. */
function unanswered(page: Page): () => number {
  let open = 0;
  const type = (payload: string | Buffer) => (JSON.parse(String(payload)) as { type?: string }).type;
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      if (type(f.payload) === "ping") open++;
    });
    ws.on("framereceived", (f) => {
      if (type(f.payload) === "pong") open--;
    });
  });
  return () => open;
}

/** The names of the folders the fake daemon was asked to make. */
function names(daemon: FakeDaemon, type: "folder.create"): string[] {
  return daemon.received.flatMap((m) => (m.type === type ? [m.name] : []));
}
