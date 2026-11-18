// The files of a session's folder (views/files.tsx): its folders, new files, what a file shows, and editing and
// saving one, from a folder that the fake daemon keeps in memory (FakeFolder). Times are of Playwright's clock, paused
// at 09:30 in Tokyo.
import type { FakeDaemon } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { FakeFolder, pauseClockAt, sessionDaemon, sessionUrl, sha256, showSessionHeader } from "./panel-data.ts";

test.use({ timezoneId: "Asia/Tokyo" });

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T09:30:00+09:00");
/** A PNG of 1×1 pixel. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const folderOf = (d: FakeDaemon) => new FakeFolder(d, { now: () => T0 });

test("フォルダー: 大きさと相対時刻、開けない項目、パンくず、空のフォルダー、件数を切ったとき、読み込んだ時刻", async ({ page, hub, isMobile }) => {
  const d = await sessionDaemon(hub);
  const f = folderOf(d);
  f.text("README.md", "# Gasho\n", { mtime: T0 - 5 * MIN });
  f.text("data.txt", `${"a".repeat(2047)}\n`, { mtime: T0 - 180 * MIN });
  f.text("src/main.ts", "console.log(1);\n");
  f.text("src/lib/util.ts", "export {};\n");
  for (const n of [1, 2, 3]) f.text(`many/a${n}.txt`, "a\n");
  f.truncated.add("many");
  f.extra.set("", [
    { name: "empty", kind: "dir" },
    { name: "outside-link", kind: "file", link: true, outside: true },
    { name: "broken-link", kind: "other", link: true },
    { name: "daemon.sock", kind: "other" },
  ]);
  f.extra.set("empty", []);
  await pauseClockAt(page, T0);
  await page.goto(sessionUrl(d));
  const panel = page.getByRole("region", { name: "ファイル" });
  const row = (name: string) => panel.getByRole("listitem").filter({ hasText: name });
  const places = panel.getByRole("navigation", { name: "場所" });

  await test.step("ヘッダーの「ファイル」で、セッションのフォルダーの一覧が開く", async () => {
    await showSessionHeader(page, isMobile);
    await page.getByTitle("このセッションのフォルダーのファイルを開く").click();
    await expect(page).toHaveURL(/\/files$/);
    await expect(places.getByText("gasho")).toHaveAttribute("aria-current", "page");
  });

  await test.step("ファイルには大きさと更新の相対時刻が出る", async () => {
    await expect(row("data.txt")).toContainText("2.0 KB · 3 時間前");
    await expect(row("README.md")).toContainText("8 B · 5 分前");
  });

  await test.step("読み込んだ時刻が出る", async () => {
    await expect(panel.getByText("09:30 に読み込み")).toBeVisible();
  });

  await test.step("時計が 2 時間進むと、相対時刻が変わる", async () => {
    await page.clock.fastForward("02:00:00");
    await expect(row("data.txt")).toContainText("2.0 KB · 5 時間前");
  });

  await test.step("開けない項目は、理由が出て、押せない", async () => {
    await expect(row("outside-link")).toContainText("フォルダーの外");
    await expect(row("broken-link")).toContainText("リンク切れ");
    await expect(row("daemon.sock")).toContainText("開けません");
    for (const name of ["outside-link", "broken-link", "daemon.sock"]) await expect(row(name).getByRole("link")).toHaveCount(0);
  });

  await test.step("フォルダーを開くとパンくずが伸び、パンくずで戻れる", async () => {
    await panel.getByRole("link", { name: "src", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/src$/);
    await panel.getByRole("link", { name: "lib", exact: true }).click();
    await expect(page).toHaveURL(/\/files\/src\/lib$/);
    await expect(row("util.ts")).toBeVisible();
    await expect(places.getByText("lib")).toHaveAttribute("aria-current", "page");
    await places.getByRole("link", { name: "src" }).click();
    await expect(page).toHaveURL(/\/files\/src$/);
    await expect(row("main.ts")).toBeVisible();
    await places.getByRole("link", { name: "gasho" }).click();
    await expect(page).toHaveURL(/\/files$/);
  });

  await test.step("空のフォルダーは、空と出る", async () => {
    await panel.getByRole("link", { name: "empty", exact: true }).click();
    await expect(panel.getByText("このフォルダーは空です。")).toBeVisible();
    await places.getByRole("link", { name: "gasho" }).click();
  });

  await test.step("件数を切ったフォルダーは、最初の何件かを出していると出る", async () => {
    await panel.getByRole("link", { name: "many", exact: true }).click();
    await expect(row("a3.txt")).toBeVisible();
    await expect(panel.getByText("名前の順に、最初の 3 件を表示しています。")).toBeVisible();
  });
});

test("新しいファイル: 名前を検査し、Esc で閉じ（変換中は閉じない）、作ると編集の状態で開く", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  const f = folderOf(d);
  f.text("README.md", "# Gasho\n");
  f.text("src/main.ts", "console.log(1);\n");
  await page.goto(sessionUrl(d, "/files"));
  const panel = page.getByRole("region", { name: "ファイル" });
  const name = page.getByLabel("新しいファイルの名前（このフォルダーに作ります）");
  const create = page.getByRole("button", { name: "作る" });
  const editor = page.getByRole("textbox", { name: "ファイルの内容" });
  // On a phone the panel's buttons are in the screen's top bar.
  const newFile = page.getByRole("button", { name: "新しいファイル" });

  await test.step("「新しいファイル」で名前の欄が開き、すぐ打てる。名前が空のうちは作れない", async () => {
    await expect(panel.getByText("README.md")).toBeVisible();
    await newFile.click();
    await expect(name).toBeFocused();
    await expect(create).toBeDisabled();
  });

  await test.step("使えない名前は、作る前に断る", async () => {
    for (const [value, problem] of [
      [" memo.md", "ファイルの名前の前後に空白は使えません。"],
      ["a/b.md", "名前に / は使えません。ほかのフォルダーに作るときは、そのフォルダーを開いてから作ってください。"],
      ["..", "この名前は使えません。"],
      ["x".repeat(256), "ファイルの名前が長すぎます。"],
    ] as const) {
      await name.fill(value);
      await create.click();
      await expect(panel.getByText(problem)).toBeVisible();
    }
    expect(f.writes).toHaveLength(0);
  });

  await test.step("同じ名前のファイルがあれば、gasho-daemon が断ったことが出る", async () => {
    await name.fill("README.md");
    await create.click();
    await expect(panel.getByText("同じ名前のファイルかフォルダーが、すでにあります：README.md")).toBeVisible();
    expect(f.writes).toMatchObject([{ path: "README.md", content: "", create: true }]);
  });

  await test.step("変換中の Esc では閉じず、ふだんの Esc で欄だけを閉じる", async () => {
    await name.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
    await expect(name).toBeVisible();
    await name.press("Escape");
    await expect(name).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(/\/files$/);
  });

  await test.step("名前を入れて作ると、空のファイルが編集の状態で開き、そのまま保存できる", async () => {
    await panel.getByRole("link", { name: "src", exact: true }).click();
    await expect(panel.getByText("main.ts")).toBeVisible();
    await newFile.click();
    await name.fill("memo.md");
    await create.click();
    await expect(page).toHaveURL(/\/file\/src\/memo\.md$/);
    await expect(editor).toHaveValue("");
    expect(f.writes.at(-1)).toMatchObject({ path: "src/memo.md", content: "", create: true });
    await editor.fill("# メモ\n");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByRole("region", { name: "memo.md" }).getByText(/保存しました/)).toBeVisible();
    expect(f.writes.at(-1)).toMatchObject({ path: "src/memo.md", content: "# メモ\n", baseHash: sha256("") });
    expect(f.files.get("src/memo.md")?.text).toBe("# メモ\n");
  });
});

test("表示: テキスト・5000 行までと 5000 行を超えるテキスト・Markdown・SVG・画像・バイナリ・UTF-8 以外・大きすぎる・空・CRLF・読み取り専用", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  const f = folderOf(d);
  f.text("src/main.ts", "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");
  f.text("limit.txt", lines(5000));
  f.text("long.txt", lines(5001));
  f.text("README.md", "# 見出し\n\n本文の段落。\n");
  f.text("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>\n');
  f.other("photo.png", { size: 68, image: { mime: "image/png", data: PNG } });
  f.other("app.bin", { size: 1024, binary: true });
  f.other("sjis.txt", { size: 12, binary: true });
  f.other("big.log", { size: 2 * 1024 * 1024, tooLarge: true });
  f.other("huge.png", { size: 6 * 1024 * 1024, tooLarge: true });
  f.text("empty.txt", "");
  f.text("win.txt", "a\r\nb\r\n");
  f.text("locked.txt", "読むだけ\n", { writable: false });
  /** Opens the file, and gives its panel. */
  const open = async (path: string) => {
    await page.goto(sessionUrl(d, `/file/${path}`));
    const panel = page.getByRole("region", { name: path.split("/").at(-1) });
    await expect(panel).toBeVisible();
    return panel;
  };
  const shows = page.getByRole("group", { name: "表示のしかた" });

  await test.step("テキストは行番号つきで出る", async () => {
    const panel = await open("src/main.ts");
    await expect(panel.getByText("console.log(a + b);")).toBeVisible();
    await expect(panel.getByText("3 行")).toBeVisible();
    await expect(panel.getByText("3", { exact: true })).toBeVisible();
  });

  await test.step("5000 行までのテキストは行番号つきで、5000 行を超えると行番号なしで出る", async () => {
    let panel = await open("limit.txt");
    await expect(panel.getByText("5000 行")).toBeVisible();
    await expect(panel.getByText("5000", { exact: true })).toHaveCount(1);
    panel = await open("long.txt");
    await expect(panel.getByText("5001 行")).toBeVisible();
    await expect(panel.getByText("line 5001")).toBeAttached();
    await expect(panel.getByText("5001", { exact: true })).toHaveCount(0);
  });

  await test.step("Markdown は、表示とテキストを切り替えられる", async () => {
    const panel = await open("README.md");
    await expect(panel.getByRole("heading", { name: "見出し" })).toBeVisible();
    await shows.getByRole("button", { name: "テキスト" }).click();
    await expect(panel.getByText("# 見出し")).toBeVisible();
    await expect(panel.getByRole("heading", { name: "見出し" })).toHaveCount(0);
    await shows.getByRole("button", { name: "表示" }).click();
    await expect(panel.getByRole("heading", { name: "見出し" })).toBeVisible();
  });

  await test.step("SVG は、絵とテキストを切り替えられる", async () => {
    const panel = await open("logo.svg");
    await expect(panel.getByRole("img", { name: "logo.svg" })).toBeVisible();
    await shows.getByRole("button", { name: "テキスト" }).click();
    await expect(panel.getByText(/^<svg /)).toBeVisible();
    await shows.getByRole("button", { name: "表示" }).click();
    await expect(panel.getByRole("img", { name: "logo.svg" })).toBeVisible();
  });

  await test.step("画像は絵で出る", async () => {
    const panel = await open("photo.png");
    const img = panel.getByRole("img", { name: "photo.png" });
    await expect(img).toBeVisible();
    await expect(img).toHaveJSProperty("naturalWidth", 1);
  });

  await test.step("バイナリと UTF-8 以外の文字コードのファイルは、表示しないと出る", async () => {
    for (const path of ["app.bin", "sjis.txt"]) {
      const panel = await open(path);
      await expect(panel.getByText("テキストのファイルではない（バイナリか、UTF-8 以外の文字コードの）ので、表示しません。")).toBeVisible();
    }
  });

  await test.step("大きすぎるファイルは、大きさと上限とともに、表示しないと出る", async () => {
    await expect((await open("big.log")).getByText("大きすぎるので表示しません（2.0 MB）。表示できるのは、テキストは 1MB、画像は 5MB までです。")).toBeVisible();
    await expect((await open("huge.png")).getByText("大きすぎるので表示しません（6.0 MB）。表示できるのは、テキストは 1MB、画像は 5MB までです。")).toBeVisible();
  });

  await test.step("空のファイルは、空と出る", async () => {
    const panel = await open("empty.txt");
    await expect(panel.getByText("空のファイルです。")).toBeVisible();
  });

  await test.step("改行が CRLF のファイルは、CRLF と出る", async () => {
    const panel = await open("win.txt");
    await expect(panel.getByText("CRLF", { exact: true })).toBeVisible();
    await expect(panel.getByText("2 行")).toBeVisible();
  });

  await test.step("読み取り専用のファイルは、そう出て、「編集」を押せない", async () => {
    const panel = await open("locked.txt");
    await expect(panel.getByText("読み取り専用")).toBeVisible();
    await expect(page.getByRole("button", { name: "編集" })).toBeDisabled();
  });
});

test("「折り返す」: スマホの幅では最初から折り返し、切り替えた設定は読み込み直しても残る", async ({ page, hub, isMobile }) => {
  const d = await sessionDaemon(hub);
  const long = `${"x".repeat(400)}の終わり`;
  folderOf(d).text("wide.txt", `${long}\n短い行\n`);
  await page.goto(sessionUrl(d, "/file/wide.txt"));
  const wrap = page.getByRole("button", { name: "折り返す" });
  const line = page.getByText(long);
  // One line is 20px high (12.5px, line-height 1.6).
  const wrapped = async () => ((await line.boundingBox())?.height ?? 0) > 30;

  await test.step(isMobile ? "スマホの幅では、最初から折り返す" : "PC の幅では、最初は折り返さない", async () => {
    await expect(wrap).toHaveAttribute("aria-pressed", String(isMobile));
    expect(await wrapped()).toBe(isMobile);
  });

  await test.step("押すと切り替わり、読み込み直しても残る", async () => {
    await wrap.click();
    await expect(wrap).toHaveAttribute("aria-pressed", String(!isMobile));
    await expect.poll(wrapped).toBe(!isMobile);
    await page.reload();
    await expect(wrap).toHaveAttribute("aria-pressed", String(!isMobile));
    await expect.poll(wrapped).toBe(!isMobile);
  });
});

test("編集: 「保存」と ⌘/Ctrl+S で保存し、未保存のまま閉じるときとページを閉じるときに確かめる", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  const f = folderOf(d);
  f.text("notes.txt", "one\n");
  await pauseClockAt(page, T0);
  await page.goto(sessionUrl(d, "/file/notes.txt"));
  const panel = page.getByRole("region", { name: "notes.txt" });
  const editor = page.getByRole("textbox", { name: "ファイルの内容" });
  const save = page.getByRole("button", { name: "保存" });
  const typeAtEnd = async (text: string) => {
    await editor.evaluate((el) => {
      const box = el as unknown as { value: string; focus(): void; setSelectionRange(start: number, end: number): void };
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    await page.keyboard.type(text);
  };

  await test.step("「編集」で編集の状態になり、変えるまでは「保存」を押せない", async () => {
    await page.getByRole("button", { name: "編集" }).click();
    await expect(editor).toHaveValue("one\n");
    await expect(save).toBeDisabled();
  });

  await test.step("変えると未保存と出て、「保存」で書き込み、「保存しました（09:30）」と出る", async () => {
    await typeAtEnd("two\n");
    await expect(panel.getByText("未保存の変更があります")).toBeVisible();
    await save.click();
    await expect(panel.getByText("保存しました（09:30）")).toBeVisible();
    await expect(panel.getByText("未保存の変更があります")).toHaveCount(0);
    expect(f.writes.at(-1)).toMatchObject({ path: "notes.txt", content: "one\ntwo\n", baseHash: sha256("one\n") });
  });

  await test.step("⌘/Ctrl+S でも保存する", async () => {
    await page.clock.fastForward("05:00");
    await typeAtEnd("three\n");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(panel.getByText("保存しました（09:35）")).toBeVisible();
    expect(f.writes.at(-1)).toMatchObject({ content: "one\ntwo\nthree\n", baseHash: sha256("one\ntwo\n") });
  });

  await test.step("保存していない変更は、フォルダーの一覧に「未保存」と出て、戻ると続きから書ける", async () => {
    await typeAtEnd("four");
    await panel.getByRole("navigation", { name: "場所" }).getByRole("link", { name: "gasho" }).click();
    const row = page.getByRole("listitem").filter({ hasText: "notes.txt" });
    await expect(row).toContainText("未保存");
    await row.getByRole("link").click();
    await expect(editor).toHaveValue("one\ntwo\nthree\nfour");
  });

  await test.step("保存していないままページを閉じようとすると、ブラウザーが確かめる", async () => {
    // Asked only after the person did something on the page (typing counts).
    const dialog = page.waitForEvent("dialog");
    await page.close({ runBeforeUnload: true });
    const asked = await dialog;
    expect(asked.type()).toBe("beforeunload");
    await asked.dismiss();
    await expect(editor).toHaveValue("one\ntwo\nthree\nfour");
  });

  await test.step("保存していないまま「やめる」を押すと確かめ、取り消すと編集を続け、捨てると保存したところに戻る", async () => {
    let message = "";
    page.once("dialog", (dlg) => {
      message = dlg.message();
      void dlg.dismiss();
    });
    await page.getByRole("button", { name: "やめる" }).click();
    await expect.poll(() => message).toBe("保存していない変更を捨てて、編集をやめますか？");
    await expect(editor).toBeVisible();
    page.once("dialog", (dlg) => void dlg.accept());
    await page.getByRole("button", { name: "やめる" }).click();
    await expect(editor).toBeHidden();
    await expect(panel.getByText("three", { exact: true })).toBeVisible();
    await expect(panel.getByText("four")).toHaveCount(0);
  });

  await test.step("working server がオフラインになると、「編集」を押せない", async () => {
    await d.disconnect();
    await expect(panel.getByText("mac はオフラインです。")).toBeVisible();
    await expect(page.getByRole("button", { name: "編集" })).toBeDisabled();
  });
});

test("競合: 読んだあとに変わったファイルの保存は断られ、「上書きして保存」と「編集を捨てて読み込み直す」を選べる", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  const f = folderOf(d);
  f.text("notes.txt", "one\n");
  await page.goto(sessionUrl(d, "/file/notes.txt"));
  const panel = page.getByRole("region", { name: "notes.txt" });
  const editor = page.getByRole("textbox", { name: "ファイルの内容" });
  const notice = panel.getByRole("alert");
  const edit = async (text: string) => {
    await page.getByRole("button", { name: "編集" }).click();
    await editor.fill(text);
  };

  await test.step("編集を始めたあとで Claude が書き換えたファイルを保存すると、断られて選び方が出る", async () => {
    await edit("one\nmine\n");
    f.text("notes.txt", "claude\n");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(notice).toContainText("保存しませんでした。このファイルは、編集を始めたあとで変更されています");
    await expect(notice.getByRole("button", { name: "上書きして保存" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "編集を捨てて読み込み直す" })).toBeVisible();
    expect(f.files.get("notes.txt")?.text).toBe("claude\n");
  });

  await test.step("「上書きして保存」で、編集した内容を今のファイルの上に書く", async () => {
    await notice.getByRole("button", { name: "上書きして保存" }).click();
    await expect(panel.getByText(/保存しました/)).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(f.files.get("notes.txt")?.text).toBe("one\nmine\n");
    expect(f.writes.at(-1)?.baseHash).toBeUndefined();
  });

  await test.step("「編集を捨てて読み込み直す」で、確かめてから今のファイルを読み込み直す", async () => {
    // Still being edited, from the version just written.
    await editor.fill("one\nmine\nmore\n");
    f.text("notes.txt", "claude again\n");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(notice).toBeVisible();
    let message = "";
    page.once("dialog", (dlg) => {
      message = dlg.message();
      void dlg.accept();
    });
    await notice.getByRole("button", { name: "編集を捨てて読み込み直す" }).click();
    await expect.poll(() => message).toBe("編集した内容を捨てて、いまのファイルを読み込み直しますか？");
    await expect(editor).toBeHidden();
    await expect(panel.getByText("claude again")).toBeVisible();
    expect(f.files.get("notes.txt")?.text).toBe("claude again\n");
  });
});

test("gasho-daemon 0.11 未満では、ファイルを開けず、古いため扱えないと出る", async ({ page, hub, isMobile }) => {
  const d = await sessionDaemon(hub, { version: "0.10.0" });
  await page.goto(sessionUrl(d));
  const tooOld = "この working server の gasho-daemon は古いため、ファイルを扱えません。gasho-daemon を 0.11.0 以上に更新してください。";

  await test.step("セッションのヘッダーに「ファイル」が出ない", async () => {
    await showSessionHeader(page, isMobile);
    await expect(page.getByTitle("ブランチグラフを開く")).toBeVisible();
    await expect(page.getByTitle("このセッションのフォルダーのファイルを開く")).toHaveCount(0);
  });

  await test.step("フォルダーとファイルの URL を開くと、古いため扱えないと出る", async () => {
    await page.goto(sessionUrl(d, "/files"));
    await expect(page.getByRole("region", { name: "ファイル" }).getByText(tooOld)).toBeVisible();
    await page.goto(sessionUrl(d, "/file/README.md"));
    await expect(page.getByRole("region", { name: "README.md" }).getByText(tooOld)).toBeVisible();
    expect(d.received.filter((m) => m.type === "dir.get" || m.type === "file.get")).toHaveLength(0);
  });
});
