// What the plugins' scenarios share: the sidebar (in its drawer on a phone), a card of the plugins screen, and the
// state a fake gasho-daemon tells of the plugins' daemon parts.
import type { DaemonPluginStatus } from "@gasho/protocol";
import type { Locator, Page } from "@playwright/test";
import { type FakeDaemon, TEST_PLUGINS } from "../harness/index.ts";
import { PLUGIN_API } from "../../apps/hub/src/plugins.ts";
import { expect } from "./fixtures.ts";

export const plugin = (id: string) => `${TEST_PLUGINS}/${id}`;

/**
 * The sidebar's items: on a phone, in the drawer, opened anew (one still closing from the step before would be gone
 * before it is used).
 */
export async function sidebar(page: Page): Promise<Locator> {
  const open = page.getByRole("button", { name: "Open navigation" });
  if (!(await open.isVisible())) return page.getByRole("navigation", { name: "Main" });
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  if ((await drawer.count()) > 0) await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await open.click();
  const nav = drawer.getByRole("navigation", { name: "Main" });
  await expect(nav).toBeVisible();
  return nav;
}

/** The session header's second row, which a phone hides until asked. */
export async function showHeader(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: "ヘッダーを表示" });
  if (await show.isVisible()) await show.click();
}

/**
 * A plugin's card in a list of the plugins screen (入れたもの, GashoPlugins にあるもの), by the name its first line starts
 * with (a note of another card may name it too).
 */
export function card(list: Locator, name: string): Locator {
  const first = list.page().locator("p:first-child", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  return list.getByRole("listitem").filter({ has: first });
}

/** What a gasho-daemon of today tells the Gasho server of its plugins' daemon parts. */
export function pluginStatus(d: FakeDaemon, plugins: DaemonPluginStatus[], api = PLUGIN_API): void {
  d.send({ type: "plugin.status", api, plugins });
}
