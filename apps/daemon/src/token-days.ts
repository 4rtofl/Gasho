// The tokens used per day, kept in token-days.json in gasho-daemon's state folder: the home screen's heatmap looks back
// a year, further than transcripts are read for, and a session's days stay after the session is removed. Each session's
// day holds what its transcripts add up to, so reading them again after a restart replaces the value and counts nothing
// twice.
import fs from "node:fs/promises";
import path from "node:path";
import type { TokenDay } from "@gasho/protocol";
import { log } from "./util.ts";

const DAY = 86_400_000;
/** Japan Standard Time, whatever the time zone of the working server or the browser. */
const JST = 9 * 3_600_000;
/** The days kept and sent: the 53 weeks that the heatmap can show. */
export const TOKEN_DAYS = 371;

/** The day (YYYY-MM-DD, Japan Standard Time) that a moment falls on. */
export function tokenDayOf(at: number): string {
  return new Date(at + JST).toISOString().slice(0, 10);
}

export class TokenDays {
  private file: string;
  private sessions = new Map<string, Map<string, number>>();
  /** The days whose total changed since they were last taken. */
  private changed = new Set<string>();
  private unsaved = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    let saved: unknown;
    try {
      saved = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      return;
    }
    if (typeof saved !== "object" || saved === null) return;
    for (const [id, days] of Object.entries(saved)) {
      if (typeof days !== "object" || days === null) continue;
      const kept = Object.entries(days).filter((d): d is [string, number] => typeof d[1] === "number" && Number.isFinite(d[1]) && d[1] > 0);
      if (kept.length > 0) this.sessions.set(id, new Map(kept));
    }
  }

  /** What a session's transcripts add up to, per day. A day they no longer have keeps the value it had. */
  record(sessionId: string, days: ReadonlyMap<string, number>, now = Date.now()): void {
    const first = tokenDayOf(now - (TOKEN_DAYS - 1) * DAY);
    let mine = this.sessions.get(sessionId);
    for (const [day, tokens] of days) {
      if (day < first || mine?.get(day) === tokens) continue;
      mine ??= new Map();
      this.sessions.set(sessionId, mine);
      mine.set(day, tokens);
      this.changed.add(day);
      this.unsaved = true;
    }
  }

  private total(day: string): number {
    let sum = 0;
    for (const days of this.sessions.values()) sum += days.get(day) ?? 0;
    return sum;
  }

  /** Every day of the last year with its total, oldest first. What had changed counts as told. */
  all(now = Date.now()): TokenDay[] {
    this.changed.clear();
    const first = tokenDayOf(now - (TOKEN_DAYS - 1) * DAY);
    const days = new Set([...this.sessions.values()].flatMap((d) => [...d.keys()]));
    return [...days]
      .filter((day) => day >= first)
      .sort()
      .map((day) => [day, this.total(day)]);
  }

  /** The days whose total changed since the last call, oldest first. */
  takeChanged(): TokenDay[] {
    const days = [...this.changed].sort().map((day): TokenDay => [day, this.total(day)]);
    this.changed.clear();
    return days;
  }

  /** Writes what changed, leaving out the days too old to be shown; a failure is tried again the next time. */
  save(now = Date.now()): Promise<void> {
    if (!this.unsaved) return this.saving;
    this.unsaved = false;
    const first = tokenDayOf(now - (TOKEN_DAYS - 1) * DAY);
    for (const [id, days] of this.sessions) {
      for (const day of days.keys()) if (day < first) days.delete(day);
      if (days.size === 0) this.sessions.delete(id);
    }
    const json = JSON.stringify(Object.fromEntries([...this.sessions].map(([id, days]) => [id, Object.fromEntries(days)])));
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, json, { mode: 0o600 });
        await fs.rename(tmp, this.file);
      })
      .catch((e: unknown) => {
        this.unsaved = true;
        log("could not save the tokens per day", e);
      });
    return this.saving;
  }
}
