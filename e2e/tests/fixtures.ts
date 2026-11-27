// Gasho's fixtures: each test gets a Gasho server of its own (hub), and a page whose browser is registered with it (the
// registration cookie). Registering with a code on the screen is a scenario of its own. And the session's chat box,
// which is a CodeMirror editor: what it holds is read from the editor, since the screen shows its Markdown formatted.
import { test as base, expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { type GashoHub, startHub } from "../harness/index.ts";
import type { HubOptions } from "../harness/hub.ts";

export const test = base.extend<{ hub: GashoHub; hubOptions: HubOptions }>({
  hubOptions: [{}, { option: true }],
  hub: async ({ hubOptions }, use, testInfo) => {
    const hub = await startHub(hubOptions);
    await use(hub);
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("gasho-logs", { body: hub.logs(), contentType: "text/plain" });
    await hub.stop();
  },
  baseURL: async ({ hub }, use) => use(hub.url),
  context: async ({ context, hub }, use) => {
    await context.addCookies([await hub.browserCookie()]);
    await use(context);
  },
});

/** The session's chat box: the editor's text field (named "シェルのコマンド" in shell mode, "メッセージ" otherwise). */
export const chatBox = (page: Page) => page.locator('[aria-placeholder="Agent への指示を入力…"]');

/**
 * The editor of a text field such as chatBox's: its text (the Markdown as typed) and where its cursor is. CodeMirror
 * keeps the editor on its text field's element (EditorView.findFromDOM reads it there).
 */
function editorOf(field: Locator) {
  return field.evaluate((el) => {
    const view = el.cmTile?.root?.view;
    if (!view) throw new Error("CodeMirror のエディタが見つかりません");
    return { text: view.state.doc.toString() as string, caret: view.state.selection.main.head as number };
  });
}
export const editorText = async (field: Locator): Promise<string> => (await editorOf(field)).text;
export const editorCaret = async (field: Locator): Promise<number> => (await editorOf(field)).caret;

/** Puts the cursor of a text field such as chatBox's at the start or the end of its text. */
export async function caretAt(field: Locator, at: "start" | "end"): Promise<void> {
  await field.evaluate((el, end) => {
    const view = el.cmTile.root.view;
    view.dispatch({ selection: { anchor: end ? view.state.doc.length : 0 } });
  }, at === "end");
}

export const expect = baseExpect.extend({
  /** The text of a text field such as chatBox's is `expected` (or matches it), within the time an expect waits. */
  async toHaveEditorText(field: Locator, expected: string | RegExp, options?: { timeout?: number }) {
    const ok = (text: string) => (typeof expected === "string" ? text === expected : expected.test(text));
    let actual = "";
    let pass = false;
    try {
      await baseExpect
        .poll(async () => ok((actual = await editorText(field))), { timeout: options?.timeout ?? this.timeout })
        .toBe(true);
      pass = true;
    } catch {
      pass = false;
    }
    return {
      pass,
      name: "toHaveEditorText",
      expected,
      actual,
      message: () => `${this.utils.matcherHint("toHaveEditorText", undefined, undefined, { isNot: this.isNot })}\n\nExpected: ${this.utils.printExpected(expected)}\nReceived: ${this.utils.printReceived(actual)}`,
    };
  },
});
