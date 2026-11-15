// The easter egg of the sidebar's logo (🙏, 合掌 gasshō), drawn by components/gassho.tsx: three taps on the logo, one to
// three seconds apart, bring its 🙏 to the middle of a dimmed screen. Pressed and held, the 🙏's two halves (its hands)
// part to the sides, trembling, and reach the screen's edges after five seconds; let go, they come back together with a
// clap (lib/clap.ts), and a second later Gasho's site opens in this tab. What can be worked out without the page is here.

/** The taps on the logo that start it, each 1 s or more and less than 3 s after the one before. */
export const TAPS = 3;
export const TAP_GAP_MIN_MS = 1000;
export const TAP_GAP_MAX_MS = 3000;
/** How long the hands take to part as far as the screen's edges, at one speed. */
export const HOLD_TO_EDGE_MS = 5000;
/** A press let go sooner is a tap: the hands go back without a clap. */
export const MIN_HOLD_MS = 500;
/** From the clap to opening the site. */
export const OPEN_AFTER_CLAP_MS = 1000;
/** The 🙏's way (s) from the logo to the middle of the screen, and the screen dimming once it is there. */
export const FLIGHT_S = 0.8;
export const DIM_S = 0.3;
/** How often (ms) the hands' trembling changes while they are held: about 30 times a second. */
export const SHAKE_MS = 33;

/** `value` within 0 to 1. */
const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** A run of taps on the logo: how many so far, and when the last one was (ms). */
export interface Taps {
  count: number;
  at: number;
}

/** Where the logo's 🙏 is when the egg starts (its middle, in px from the window's top left) and its font size (px). */
export interface GasshoFrom {
  x: number;
  y: number;
  size: number;
}

/** The run after a tap at `now`: one more when it came in time after the last, or else a new run that it starts. */
export function countTap(last: Taps | undefined, now: number): Taps {
  if (last && last.count < TAPS) {
    const gap = now - last.at;
    if (gap >= TAP_GAP_MIN_MS && gap < TAP_GAP_MAX_MS) return { count: last.count + 1, at: now };
  }
  return { count: 1, at: now };
}

/**
 * How far (px) each hand goes when they are parted all the way: its outer side reaches the screen's edge. The 🙏 is
 * drawn about as wide as its font size (`glyphSize`); the box of the character around it is wider, by the font.
 */
export function edgeDistance(screenWidth: number, glyphSize: number): number {
  return Math.max(0, (screenWidth - glyphSize) / 2);
}

/** How long (s) the hands take from `spread` (0: together, 1: at the edges) to the edges, at the one speed. */
export function holdDuration(spread: number): number {
  return (unit(1 - spread) * HOLD_TO_EDGE_MS) / 1000;
}

/** How long (s) the hands take to come back together for the clap from `spread`: quick, a little longer from afar. */
export function clapDuration(spread: number): number {
  return 0.08 + 0.12 * unit(spread);
}

/**
 * How far (px) each hand shifts at most, up and down and to the sides, trembling `spread` apart: from 1% of the 🙏's
 * size (`glyphSize`) as they start to part, to 4% at the edges.
 */
export function shakeShift(spread: number, glyphSize: number): number {
  return glyphSize * (0.01 + 0.03 * unit(spread));
}

/** How far (degrees) each hand turns at most, either way, trembling `spread` apart: from 1° to 3° at the edges. */
export function shakeTurn(spread: number): number {
  return 1 + 2 * unit(spread);
}

/** The 🙏's font size (px) in the middle of the screen: 36% of the screen's shorter side, at most 200 px. */
export function centreSize(width: number, height: number): number {
  return Math.round(Math.min(200, 0.36 * Math.min(width, height)));
}

/**
 * A recording's sound: its loudest sample, and where the sound starts (the first sample at a tenth of the loudest or
 * more, on any channel), so that the silence before it can be skipped.
 */
export function soundStart(channels: ArrayLike<number>[]): { start: number; peak: number } {
  let peak = 0;
  for (const samples of channels) for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const level = peak / 10;
  let start = Number.POSITIVE_INFINITY;
  for (const samples of channels) {
    for (let i = 0; i < Math.min(samples.length, start); i++) {
      if (Math.abs(samples[i]) >= level && peak > 0) {
        start = i;
        break;
      }
    }
  }
  return { start: Number.isFinite(start) ? start : 0, peak };
}
