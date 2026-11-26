import assert from "node:assert/strict";
import { test } from "node:test";
import { PLUGIN_API } from "@gasho/plugin-sdk/exports";
import { apiSupported, checkDefinition } from "../src/plugins/definition.ts";

test("the screen runs plugins written for its API's major and a minor up to its own, compared as numbers", () => {
  const [major = 0, minor = 0] = PLUGIN_API.split(".").map(Number);
  assert.equal(apiSupported(PLUGIN_API), true);
  assert.equal(apiSupported(`${major}.0`), true);
  assert.equal(apiSupported(`${major}.${Math.max(0, minor - 1)}`), true);
  // 1.9 is older than 1.10, though "9" comes after "10" as text.
  assert.equal(apiSupported(`${major}.9`), minor >= 9);
  assert.equal(apiSupported(`${major}.${minor + 1}`), false);
  assert.equal(apiSupported(`${major + 1}.0`), false);
  assert.equal(apiSupported(`${major - 1}.${minor}`), false);
  for (const odd of [`${major}`, `${major}.${minor}.0`, `${major}.x`, "", ` ${PLUGIN_API}`]) assert.equal(apiSupported(odd), false, odd);
});

test("a web.js definition of the right shape is taken as it is", () => {
  const def = {
    sidebar: [{ id: "a" }],
    homeTiles: [],
    pages: { main: {} },
    pagePanels: { notes: {} },
    settings: () => null,
    sessionList: { useCategories: () => [], hideSessionTabs: true },
    worktreeGroupings: [{ id: "g", label: "分け方", useCategories: () => [] }],
    fileViewers: [{ id: "v", extensions: ["png", ".JPG"], component: () => null }],
  };
  assert.equal(checkDefinition(def), def);
  assert.deepEqual(checkDefinition({}), {});
});

test("a web.js definition that would fail to be drawn is refused, saying what to change", () => {
  const refused = (d: unknown) => {
    try {
      checkDefinition(d);
    } catch (e) {
      return (e as Error).message;
    }
    return assert.fail(`taken: ${JSON.stringify(d)}`);
  };
  for (const d of [undefined, null, [], "plugin", () => ({})]) assert.match(refused(d), /^web\.js が、プラグイン/);
  // Every place of the SDK's PluginDefinition is checked, each a list of items with an id or an object.
  for (const k of ["sidebar", "sessionHeader", "homeTiles", "conversationEnd", "composerFooter", "worktreeTabs", "fileViewers"]) {
    assert.equal(refused({ [k]: {} }), `${k} は配列にしてください。`);
    assert.equal(refused({ [k]: [{ id: "" }] }), `${k} の項目に id がありません。`);
  }
  assert.equal(refused({ conversationEnd: [null] }), "conversationEnd の項目に id がありません。");
  // The file panel matches every file it opens against a viewer's extensions.
  for (const extensions of [undefined, "png", [], ["."], ["png", 3]]) {
    assert.equal(refused({ fileViewers: [{ id: "v", extensions }] }), 'fileViewers の v の extensions は、拡張子（"png" など）の配列にしてください。');
  }
  for (const k of ["pages", "sessionPanels", "pagePanels", "worktreeViews"]) assert.equal(refused({ [k]: [] }), `${k} はオブジェクトにしてください。`);
  assert.equal(refused({ pagePanels: "notes" }), "pagePanels はオブジェクトにしてください。");
  assert.equal(refused({ settings: {} }), "settings は部品にしてください。");
  assert.equal(refused({ sessionList: { useCategories: [] } }), "sessionList には、関数 useCategories を書いてください。");
  assert.equal(refused({ sessionList: { useCategories: () => [], hideSessionTabs: "yes" } }), "sessionList の hideSessionTabs は true か false にしてください。");
  assert.equal(refused({ worktreeGroupings: {} }), "worktreeGroupings は配列にしてください。");
});
