// What the scenarios of starting a session, the worktree screen and registering repositories share: the plugin that
// brings the sidebar's "新しいセッション" and the categories' "＋" (P17), the sidebar of a computer or of a phone, the
// fake daemon's answers to a launch, and the Enter that confirms what a Japanese input method converts.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { CommandResult, HubToDaemon, SessionInfo } from "@gasho/protocol";
import { commandResult, type FakeDaemon, fakeSession, GASHO_DIR } from "../harness/index.ts";
import { expect } from "./fixtures.ts";

/** A plugin whose session list has a category, with a "＋", for each worktree, and hides the tabs above a session. */
export const CATEGORIES_PLUGIN = path.join(GASHO_DIR, "e2e/plugins/session-categories");

type Launch = Extract<HubToDaemon, { type: "session.launch" }>;

/** A promise the test settles: for an answer that comes when the test says so. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** What gasho-daemon does once a session has started: it lists the session, then answers with its id. */
export function started(daemon: FakeDaemon, msg: Launch, extra: Partial<CommandResult> = {}, session: Partial<SessionInfo> = {}) {
  const sessionId = randomUUID();
  daemon.setSessions([...daemon.sessions, fakeSession({ sessionId, cwd: msg.cwd, ...(msg.name ? { name: msg.name } : {}), ...session })]);
  return commandResult(msg, { ok: true, sessionId, ...extra });
}

/** The launches the fake daemon got, oldest first. */
export function launches(daemon: FakeDaemon): Launch[] {
  return daemon.received.filter((m): m is Launch => m.type === "session.launch");
}

/** Waits until the fake daemon has started a session in `cwd`, and the page shows the last one it started there. */
export async function expectSessionOpen(page: Page, daemon: FakeDaemon, cwd: string): Promise<void> {
  const last = () => daemon.sessions.findLast((x) => x.cwd === cwd)?.sessionId;
  await expect.poll(last, { message: `a session in ${cwd}` }).toBeDefined();
  await expect(page).toHaveURL(new RegExp(`#/s/${encodeURIComponent(daemon.machineId)}/${last()}$`));
  await expect(page.getByPlaceholder("Agent への指示を入力…")).toBeVisible();
}

/** Below md (768px), the sidebar is a drawer opened from the top bar. */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/**
 * The sidebar: on a phone, the drawer, opened first. Not while the drawer closes: it shows until it has slid out (see
 * pressInSidebar).
 */
export async function sidebar(page: Page): Promise<Locator> {
  if (!isPhone(page)) return page.getByRole("navigation", { name: "メニュー" });
  const drawer = page.getByRole("dialog", { name: "サイドバー" });
  if (!(await drawer.isVisible())) await page.getByRole("button", { name: "サイドバーを開く" }).click();
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Presses a row or the title's action of the sidebar, which close the drawer, and waits until the drawer has gone. */
export async function pressInSidebar(page: Page, name: string | RegExp): Promise<void> {
  await (await sidebar(page)).getByRole("button", typeof name === "string" ? { name, exact: true } : { name }).click();
  if (isPhone(page)) await expect(page.getByRole("dialog", { name: "サイドバー" })).toBeHidden();
}

/** Waits until the home screen tells how many working servers there are (the form is then made with them). */
export async function openHome(page: Page, machines: number): Promise<void> {
  await page.goto("/");
  await expect(page.getByText(new RegExp(`^${machines} 台の working server`))).toBeVisible();
}

/**
 * Presses the Enter that confirms what an input method converts, in a field. A test cannot drive an input method, so
 * the keydown is dispatched as browsers send it: Chromium's with isComposing, Safari's without it but with keyCode 229.
 */
export async function confirmConversion(field: Locator, browser: "chromium" | "safari" = "chromium"): Promise<void> {
  await field.evaluate((el, safari) => {
    // The page's own classes (e2e/ is type-checked without the DOM's types).
    const page = globalThis as unknown as { KeyboardEvent: new (type: string, init: object) => object };
    const e = new page.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, isComposing: !safari });
    if (safari) Object.defineProperty(e, "keyCode", { value: 229 });
    (el as unknown as { dispatchEvent: (e: object) => boolean }).dispatchEvent(e);
  }, browser === "safari");
}
