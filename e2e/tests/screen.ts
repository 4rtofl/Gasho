// What the scenarios of the whole screen share: where the connection is told (the sidebar's footer on a computer, the
// top bar on a phone), and the drawer that holds the sidebar on a phone.
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect } from "./fixtures.ts";

export interface PageConnection {
  /** How many connections the page has made to the Gasho server. */
  readonly made: number;
  /** Closes the page's connection, as a network that lost it; the Gasho server keeps running, and the page connects again. */
  drop(): Promise<void>;
}

/** Passes the page's connection to the Gasho server (/ws/client) through the test, to drop it. Set before the page opens. */
export async function routeConnection(page: Page): Promise<PageConnection> {
  const open: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
  let made = 0;
  await page.routeWebSocket(/\/ws\/client$/, (ws) => {
    made++;
    open.push({ page: ws, server: ws.connectToServer() });
  });
  return {
    get made() {
      return made;
    },
    async drop() {
      for (const c of open.splice(0)) {
        await c.server.close().catch(() => undefined);
        // Not 4401, with which the Gasho server tells a browser it is no longer registered.
        await c.page.close({ code: 4000, reason: "dropped by the test" }).catch(() => undefined);
      }
    },
  };
}

/** Below md (apps/web/src/lib/media.ts), the sidebar is a drawer and the top bar shows. */
export const onPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 768;

/** On a phone, opens the drawer that holds the sidebar; on a computer, the sidebar is there already. */
export async function openSidebar(page: Page): Promise<void> {
  if (onPhone(page)) await page.getByRole("button", { name: "Open navigation" }).click();
}

/** On a phone, closes the drawer (it is a dialog: an open one keeps the page from reloading itself for a new build). */
export async function closeSidebar(page: Page): Promise<void> {
  if (!onPhone(page)) return;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeHidden();
}

/** The connection as the screen tells it: 接続中 · <this browser's name> in the sidebar's footer, or 再接続中…. */
export async function expectConnection(page: Page, connected: boolean, deviceName: string, timeout?: number): Promise<void> {
  if (!onPhone(page)) {
    await expect(page.getByText(`${connected ? "接続中" : "再接続中…"} · ${deviceName}`, { exact: true })).toBeVisible({ timeout });
    return;
  }
  // The top bar tells only of a connection that is down; the drawer's footer tells both.
  const topBar = page.getByRole("banner").getByText("再接続中…", { exact: true });
  if (!connected) {
    await expect(topBar).toBeVisible({ timeout });
    return;
  }
  await expect(topBar).toBeHidden({ timeout });
  await openSidebar(page);
  await expect(page.getByRole("dialog", { name: "Navigation" }).getByText(`接続中 · ${deviceName}`, { exact: true })).toBeVisible();
  await closeSidebar(page);
}
