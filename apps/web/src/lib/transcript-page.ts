// How a page of a conversation, read from the working server, joins what this page has loaded of it.
import type { TranscriptEntry, TranscriptPage } from "@gasho/protocol";
import type { TranscriptState } from "./store.ts";

export function sameEntry(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.uuid !== "" && a.uuid === b.uuid;
}

/**
 * Where the latest page starts among the entries loaded (`had`, entries[0] being entry `start`): by its first entry
 * with a uuid, found among them, or else by its index, within them or right after them. -1 when it starts before them,
 * or further on (more entries came meanwhile than a page holds).
 */
function joinAt(had: readonly TranscriptEntry[], start: number, page: TranscriptPage): number {
  // The indexes loaded can be off (an entry missing): a uuid places the page even then.
  const k = page.entries.findIndex((p) => p.uuid !== "");
  const first = page.entries[k];
  const found = first ? had.findIndex((e) => sameEntry(e, first)) : -1;
  if (found >= 0) return Math.max(found - k, 0);
  // Live entries that came after the new connection are at the end of `had`, in the page too or newer than it: they
  // do not reach the page, so they are not counted as loaded.
  const lastTs = page.entries.at(-1)?.ts;
  const live = had.findIndex(
    (e) => page.entries.some((p) => sameEntry(p, e)) || (lastTs !== undefined && e.ts !== undefined && e.ts > lastTs),
  );
  const loaded = live >= 0 ? live : had.length;
  const at = page.start - start;
  return at >= 0 && at <= loaded ? at : -1;
}

/**
 * The conversation once a page has come. A page older than what is loaded goes above it. The latest page (asked for
 * on opening the conversation, and again on each new connection) takes the place of what it covers: the older entries
 * the reader scrolled up to stay above it when it joins them, and live entries that came after it was read stay below.
 */
export function takePage(cur: TranscriptState | undefined, page: TranscriptPage): TranscriptState {
  const had = cur?.entries ?? [];
  if (cur && had.length > 0 && page.start + page.entries.length <= cur.start) {
    return { entries: [...page.entries, ...had], start: page.start, total: page.total, loading: false };
  }
  const at = cur ? joinAt(had, cur.start, page) : -1;
  // Should `at` be off still, an entry would show twice (and with the same key).
  const kept = at > 0 ? had.slice(0, at).filter((e) => !page.entries.some((p) => sameEntry(p, e))) : [];
  // Keep live entries that arrived after the page was read.
  const extra = had.slice(Math.max(at, 0)).filter((e) => e.uuid && !page.entries.some((p) => sameEntry(p, e)));
  const lastTs = page.entries.at(-1)?.ts;
  // With an empty page (a brand-new session) every live entry is newer than the page.
  const tail = lastTs ? extra.filter((e) => e.ts && e.ts > lastTs) : extra;
  return {
    entries: [...kept, ...page.entries, ...tail],
    start: cur && kept.length > 0 ? cur.start : page.start,
    total: page.total + tail.length,
    loading: false,
  };
}
