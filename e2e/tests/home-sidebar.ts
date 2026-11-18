// What the scenarios of the home screen and the sidebar share: sessions in worktrees of repositories, the hooks a
// gasho-daemon relays, and drags with a mouse or a finger. Playwright drags only with the mouse: a finger's drag is
// made of pointer events of pointerType "touch", which the screen's drags (lib/sortable.ts, framer-motion) read.
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import type { HookEvent, SessionInfo } from "@gasho/protocol";
import { type FakeDaemon, fakeSession } from "../harness/index.ts";

/** Where the sessions' repository is on the fake working servers. */
export const REPO = "/work/gasho";

/**
 * A session started from Gasho, in the worktree of branch `branch` (its own folder) of the repository at `repo`
 * (named after its folder), as gasho-daemon tells it.
 */
export function worktreeSession(
  name: string,
  o: Partial<SessionInfo> & { branch?: string; repo?: string } = {},
): SessionInfo {
  const { branch = name, repo = REPO, ...rest } = o;
  const path = branch === "main" ? repo : `${repo}-${branch.replace(/\//g, "-")}`;
  return fakeSession({ sessionId: randomUUID(), cwd: path, name, gitBranch: branch, worktree: { path, repo, branch }, ...rest });
}

/** A hook of a session, as gasho-daemon sends it when Claude Code runs its hooks. */
export function sendHook(d: FakeDaemon, sessionId: string, event: string, more: Partial<HookEvent> = {}): void {
  d.send({ type: "hook", event: { sessionId, event, at: Date.now(), ...more } });
}

/** What the functions run in the page use of its window (e2e/ is type-checked without the DOM's types). */
type PageWindow = {
  requestAnimationFrame(f: () => void): void;
  document: { body: PageElement; elementFromPoint(x: number, y: number): PageElement | null };
  PointerEvent: new (type: string, init: object) => object;
};
type PageElement = { dispatchEvent(e: object): boolean };

/** Until the screen has drawn twice: what a drag moved is then shown, and read by the drag's next step. */
export async function frames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PageWindow;
    return new Promise<void>((r) => w.requestAnimationFrame(() => w.requestAnimationFrame(() => r())));
  });
}

/**
 * The middle of `l` in the window, once it is in the window and has stopped moving (an item that was just put in
 * another place slides there).
 */
async function middleOf(l: Locator): Promise<{ x: number; y: number }> {
  await l.scrollIntoViewIfNeeded();
  let last: { x: number; y: number } | undefined;
  await expect
    .poll(async () => {
      const box = await l.boundingBox();
      const p = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const still = Boolean(p && last && Math.abs(p.x - last.x) < 0.5 && Math.abs(p.y - last.y) < 0.5);
      last = p ?? undefined;
      return still;
    }, { message: `${l.toString()} stays still in the window`, intervals: [50, 100, 100, 250] })
    .toBe(true);
  return last!;
}

/** A point on `l`: its middle, moved by `dx`, `dy` px. */
export async function pointOn(l: Locator, dx = 0, dy = 0): Promise<{ x: number; y: number }> {
  const p = await middleOf(l);
  return { x: p.x + dx, y: p.y + dy };
}

type Point = { x: number; y: number };

/**
 * A drag under way, pressed on an element: moved in steps a frame apart, then dropped (or cancelled with Esc before).
 * What a drop keeps is what is shown when it is dropped, so a test waits for what it expects before dropping.
 */
export interface Drag {
  to(p: Point, steps?: number): Promise<void>;
  drop(): Promise<void>;
}

/** The pointer events of one finger, of pointerType "touch", sent where the finger is. */
function finger(page: Page, from: Point): Drag {
  let at = from;
  const send = (type: string, p: Point, buttons: number) =>
    page.evaluate(
      ({ type, p, buttons }) => {
        const w = globalThis as unknown as PageWindow;
        const init = {
          pointerId: 41,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          buttons,
          clientX: p.x,
          clientY: p.y,
          bubbles: true,
          cancelable: true,
          composed: true,
        };
        (w.document.elementFromPoint(p.x, p.y) ?? w.document.body).dispatchEvent(new w.PointerEvent(type, init));
      },
      { type, p, buttons },
    );
  return {
    async to(p, steps = 12) {
      const start = at;
      for (let i = 1; i <= steps; i++) {
        await frames(page);
        await send("pointermove", { x: start.x + ((p.x - start.x) * i) / steps, y: start.y + ((p.y - start.y) * i) / steps }, 1);
      }
      at = p;
      await frames(page);
    },
    async drop() {
      await send("pointerup", at, 0);
    },
  };
}

/** Presses `from` at its middle, with a finger on a phone, with the mouse on a computer, to drag it. */
export async function startDrag(page: Page, isMobile: boolean, from: Locator): Promise<Drag> {
  const start = await middleOf(from);
  if (isMobile) {
    const f = finger(page, start);
    await page.evaluate((p) => {
      const w = globalThis as unknown as PageWindow;
      (w.document.elementFromPoint(p.x, p.y) ?? w.document.body).dispatchEvent(
        new w.PointerEvent("pointerdown", { pointerId: 41, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, composed: true }),
      );
    }, start);
    return f;
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return {
    async to(p, steps = 12) {
      await page.mouse.move(p.x, p.y, { steps });
      await frames(page);
    },
    async drop() {
      await page.mouse.up();
    },
  };
}

/** A drag from the middle of `from` to `to`, dropped at once. */
export async function drag(page: Page, isMobile: boolean, from: Locator, to: Point): Promise<void> {
  const d = await startDrag(page, isMobile, from);
  await d.to(to);
  await d.drop();
}
