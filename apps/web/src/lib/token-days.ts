// The tokens used per day, as the working servers tell them: days are those of Japan Standard Time, wherever the
// browser is.
import type { TokenDay } from "@gasho/protocol";

const JST = 9 * 3_600_000;

/** The day (YYYY-MM-DD, Japan Standard Time) that a moment falls on. */
export const tokenDayOf = (at: number): string => new Date(at + JST).toISOString().slice(0, 10);

/** The days of all working servers added together, oldest first. */
export function sumTokenDays(byMachine: Record<string, TokenDay[]>): { date: string; value: number }[] {
  const sum = new Map<string, number>();
  for (const days of Object.values(byMachine)) for (const [day, tokens] of days) sum.set(day, (sum.get(day) ?? 0) + tokens);
  return [...sum].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

/** A working server's days with `changed` put in: each is that day's new total. */
export function mergeTokenDays(days: readonly TokenDay[], changed: readonly TokenDay[]): TokenDay[] {
  const merged = new Map(days);
  for (const [day, tokens] of changed) merged.set(day, tokens);
  return [...merged].sort((a, b) => a[0].localeCompare(b[0]));
}
