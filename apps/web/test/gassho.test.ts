import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HOLD_TO_EDGE_MS,
  TAPS,
  TAP_GAP_MAX_MS,
  TAP_GAP_MIN_MS,
  centreSize,
  clapDuration,
  countTap,
  edgeDistance,
  holdDuration,
  soundStart,
  type Taps,
} from "../src/lib/gassho.ts";

/** The run after taps at these times (ms). */
function run(times: number[]): Taps | undefined {
  let taps: Taps | undefined;
  for (const t of times) taps = countTap(taps, t);
  return taps;
}

test("taps one to three seconds apart count on, up to the three that start the egg", () => {
  assert.equal(TAPS, 3);
  assert.deepEqual(run([0]), { count: 1, at: 0 });
  assert.deepEqual(run([0, 1500]), { count: 2, at: 1500 });
  assert.deepEqual(run([0, 1500, 3000]), { count: 3, at: 3000 });
  // The edges of the gap: 1 s counts, 3 s does not.
  assert.equal(run([0, TAP_GAP_MIN_MS, 2 * TAP_GAP_MIN_MS])?.count, 3);
  assert.equal(run([0, TAP_GAP_MAX_MS - 1, 2 * (TAP_GAP_MAX_MS - 1)])?.count, 3);
});

test("a tap too soon or too late after the last starts a new run from itself", () => {
  assert.deepEqual(run([0, TAP_GAP_MIN_MS - 1]), { count: 1, at: TAP_GAP_MIN_MS - 1 });
  assert.deepEqual(run([0, TAP_GAP_MAX_MS]), { count: 1, at: TAP_GAP_MAX_MS });
  // A double click in the middle: the run starts again from its second click.
  assert.deepEqual(run([0, 1500, 1700, 3200]), { count: 2, at: 3200 });
  assert.equal(run([0, 1500, 1700, 3200, 4700])?.count, 3);
  // A long pause between the second and third taps.
  assert.deepEqual(run([0, 1500, 5000]), { count: 1, at: 5000 });
});

test("a run that reached three starts again with the next tap", () => {
  assert.deepEqual(run([0, 1500, 3000, 4500]), { count: 1, at: 4500 });
});

test("the hands part as far as the screen's edges", () => {
  // Each hand's outer side reaches the edge: half of what the 🙏 leaves of the width.
  assert.equal(edgeDistance(1440, 200), 620);
  assert.equal(edgeDistance(390, 140), 125);
  assert.equal(edgeDistance(100, 140), 0);
});

test("the hands part at one speed, reaching the edges after five seconds", () => {
  assert.equal(HOLD_TO_EDGE_MS, 5000);
  assert.equal(holdDuration(0), 5);
  assert.equal(holdDuration(0.5), 2.5);
  assert.equal(holdDuration(1), 0);
  // A hand already a little apart (pressed again while it went back), and out of range.
  assert.equal(holdDuration(0.2), 4);
  assert.equal(holdDuration(-0.1), 5);
  assert.equal(holdDuration(1.2), 0);
});

test("the hands come back together quickly, a little longer from afar", () => {
  assert.equal(clapDuration(0), 0.08);
  assert.equal(clapDuration(1), 0.2);
  assert.ok(clapDuration(0.5) > clapDuration(0.25));
  assert.equal(clapDuration(2), 0.2);
});

test("the 🙏 in the middle is 36% of the screen's shorter side, at most 200 px", () => {
  assert.equal(centreSize(390, 844), 140);
  assert.equal(centreSize(844, 390), 140);
  assert.equal(centreSize(1440, 900), 200);
});

test("a recording's sound starts at the first sample a tenth as loud as its loudest", () => {
  const silence = new Array<number>(100).fill(0.001);
  const clap = [...silence, 0.05, -0.3, 0.8, -0.5, 0.2];
  assert.deepEqual(soundStart([clap]), { start: 101, peak: 0.8 });
  // On any channel: the earliest of them.
  const later = [...silence, 0, 0, 0.9, 0, 0];
  assert.deepEqual(soundStart([later, clap]), { start: 101, peak: 0.9 });
  // Nothing but silence, or nothing at all.
  assert.deepEqual(soundStart([new Array<number>(10).fill(0)]), { start: 0, peak: 0 });
  assert.deepEqual(soundStart([]), { start: 0, peak: 0 });
});
