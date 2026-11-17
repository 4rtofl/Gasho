// What useRequest (requests.ts) keeps of a call, and when a part shown reads it again. Apart from React and the
// connection to the Gasho server, so that the tests can load it.

export interface Entry {
  loading: boolean;
  data?: unknown;
  error?: string;
  /** When `data` was read. */
  at?: number;
  /** When the last call failed. */
  failedAt?: number;
}

/** The entry once a call ended. On an error, what was read before stays, with the error. */
export function settle(was: Entry | undefined, r: { result?: unknown; error?: string }, now: number): Entry {
  return r.error !== undefined ? { ...was, loading: false, error: r.error, failedAt: now } : { loading: false, data: r.result, at: now };
}

/**
 * Whether a part shown now calls again. A result is kept until it is older than `staleSeconds` (without it, while the
 * page is open). A call that failed with nothing read is called again once `staleSeconds` passed since it failed, and
 * without `staleSeconds` at once: else the error stays after its cause is fixed.
 */
export function wantsRead(e: Entry | undefined, staleSeconds: number | undefined, now: number): boolean {
  if (!e) return true;
  if (e.loading) return false;
  if (e.at !== undefined) return staleSeconds !== undefined && now - e.at >= staleSeconds * 1000;
  return e.failedAt === undefined || now - e.failedAt >= (staleSeconds ?? 0) * 1000;
}
