import assert from "node:assert/strict";
import { test } from "node:test";
import { arrayMove, gridIndex, listIndex, type Rect } from "../src/lib/sortable.ts";

test("arrayMove takes the item out and puts it at the new place", () => {
  assert.deepEqual(arrayMove(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(arrayMove(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(arrayMove(["a", "b"], 1, 1), ["a", "b"]);
});

const rows = (n: number, height = 36): Rect[] => Array.from({ length: n }, (_, i) => ({ left: 0, top: i * height, width: 200, height }));

test("in a list, the dragged item passes an item once its edge is past that item's middle", () => {
  // Item 0 (36 high) dragged down: it passes item 1 (middle 54) once its bottom is past it, which is once its own
  // middle is past the line between them (36), as before for rows of one height.
  assert.equal(listIndex(rows(4), 0, 12), 0);
  assert.equal(listIndex(rows(4), 0, 22), 1);
  assert.equal(listIndex(rows(4), 0, 182), 3);
  assert.equal(listIndex(rows(4), 0, -68), 0);
  // Item 3 dragged up: it passes item 2 (middle 90) once its top is above it.
  assert.equal(listIndex(rows(4), 3, 95), 3);
  assert.equal(listIndex(rows(4), 3, 85), 2);
  assert.equal(listIndex(rows(4), 3, 0), 0);
});

/** The places of blocks of these heights, one under another, in this order. */
const stack = (heights: readonly number[]): Rect[] => {
  let top = 0;
  return heights.map((height) => {
    const r = { left: 0, top, width: 200, height };
    top += height;
    return r;
  });
};

/** What the order becomes, frame after frame, while the dragged block is held still with its top at `top`. */
function heldStill(heights: Record<string, number>, order: string[], dragged: string, top: number, frames = 6): string[][] {
  const seen: string[][] = [];
  let now = order;
  for (let i = 0; i < frames; i++) {
    const from = now.indexOf(dragged);
    now = arrayMove(now, from, listIndex(stack(now.map((id) => heights[id]!)), from, top));
    seen.push(now);
  }
  return seen;
}

test("in a list of blocks of different heights, a block held still stays where it went", () => {
  // A category of 9 sessions above one of 1: with the nearest middle, the small one dragged up by 113–239 px swapped
  // places with the big one every 60 ms while held still.
  const heights = { big: 352, small: 100 };
  for (let up = 0; up <= 352; up += 1) {
    const frames = heldStill(heights, ["big", "small"], "small", 352 - up);
    const last = frames.at(-1)!;
    assert.ok(frames.every((o) => o.join() === last.join()), `held ${up} px up: ${frames.map((o) => o.join("/")).join(" → ")}`);
    // It goes before the big one once its top is above the big one's middle.
    assert.deepEqual(last, up > 352 - 176 ? ["small", "big"] : ["big", "small"]);
  }
  // And the big one dragged down past the small one.
  for (let down = 0; down <= 100; down += 1) {
    const frames = heldStill(heights, ["big", "small"], "big", down);
    const last = frames.at(-1)!;
    assert.ok(frames.every((o) => o.join() === last.join()), `held ${down} px down`);
  }
});

/**
 * Where CSS grid puts tiles of these sizes ([columns, rows]) with `grid-auto-flow: row`: each after the one before,
 * in the first cells free. Cells of 100 × 100, no gaps.
 */
function place(spans: readonly (readonly [number, number])[], columns: number): Rect[] {
  const taken = new Set<string>();
  let row = 0;
  let col = 0;
  return spans.map(([w, h]) => {
    const free = () => {
      for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) if (taken.has(`${r},${c}`)) return false;
      return true;
    };
    while (col + w > columns || !free()) {
      col++;
      if (col + w > columns) {
        row++;
        col = 0;
      }
    }
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) taken.add(`${r},${c}`);
    const rect = { left: col * 100, top: row * 100, width: w * 100, height: h * 100 };
    col += w;
    return rect;
  });
}

// The home screen's tiles: on a computer (4 columns) and on a phone (2 columns).
const DESKTOP: Record<string, readonly [number, number]> = {
  busy: [1, 1],
  waiting: [1, 1],
  idle: [1, 1],
  sent: [1, 1],
  sessions: [3, 1],
  notifications: [1, 2],
  tokens: [1, 1],
  tokenBreakdown: [2, 1],
  operations: [2, 1],
  github: [1, 1],
  machines: [1, 1],
};
const PHONE: Record<string, readonly [number, number]> = {
  ...Object.fromEntries(Object.keys(DESKTOP).map((id) => [id, [2, 1] as const])),
  busy: [1, 1],
  waiting: [1, 1],
  idle: [1, 1],
  sent: [1, 1],
};
const TILES = Object.keys(DESKTOP);

test("in a grid, a tile goes before the tile under the pointer, or after it past its middle", () => {
  const rects = place(TILES.map((id) => DESKTOP[id]!), 4);
  // "busy" over the left half of "waiting" stays; past its middle, it goes after it.
  assert.equal(gridIndex(rects, 0, { x: 120, y: 50 }, 400), 0);
  assert.equal(gridIndex(rects, 0, { x: 180, y: 50 }, 400), 1);
  // "sent" over the left half of "busy" goes first; "busy" over the right half of "sessions" goes after it.
  assert.equal(gridIndex(rects, 3, { x: 20, y: 50 }, 400), 0);
  assert.equal(gridIndex(rects, 0, { x: 290, y: 150 }, 400), 4);
  // Over its own place, it goes back there; over an empty cell, nothing changes.
  assert.equal(gridIndex(rects, 2, { x: 250, y: 50 }, 400), 2);
  assert.equal(gridIndex(rects, 0, { x: 450, y: 50 }, 400), undefined);
  // On a phone, a tile as wide as the grid splits into upper and lower halves.
  const phone = place(TILES.map((id) => PHONE[id]!), 2);
  assert.equal(gridIndex(phone, 0, { x: 150, y: 220 }, 200), 3);
  assert.equal(gridIndex(phone, 0, { x: 50, y: 280 }, 200), 4);
});

test("in a grid, the tiles' places when the drag began decide: judged by the places now, a tile held still can keep swapping", () => {
  // "busy" held at the right of the third row. Judged by the places now, it goes before "notifications", which puts
  // the token breakdown under the pointer; after that, then before "notifications" again, and so on.
  const p = { x: 305, y: 205 };
  let order = TILES;
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const from = order.indexOf("busy");
    const to = gridIndex(place(order.map((id) => DESKTOP[id]!), 4), from, p, 400);
    if (to === undefined || to === from) break;
    order = arrayMove(order, from, to);
    seen.push(order.join(" "));
  }
  assert.ok(new Set(seen).size < seen.length, "judged by the places now, the order goes back and forth");
  // Judged by the places when the drag began, the place depends on the pointer alone.
  const places = place(TILES.map((id) => DESKTOP[id]!), 4);
  assert.equal(gridIndex(places, 0, p, 400), 4);
});
