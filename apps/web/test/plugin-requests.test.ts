import assert from "node:assert/strict";
import { test } from "node:test";
import { settle, wantsRead } from "../src/plugins/request-entry.ts";

const S = 1000;

test("a call that failed with nothing read is called again when next shown: at once with staleSeconds 0 or without it, else once staleSeconds passed since it failed", () => {
  const failed = settle({ loading: true }, { error: "gh: not logged in" }, 100 * S);
  assert.equal(failed.error, "gh: not logged in");
  assert.equal(wantsRead(failed, 0, 100 * S), true);
  assert.equal(wantsRead(failed, undefined, 100 * S), true);
  assert.equal(wantsRead(failed, 60, 159 * S), false);
  assert.equal(wantsRead(failed, 60, 160 * S), true);
  // While the call is on its way, the parts shown do not call again.
  assert.equal(wantsRead({ ...failed, loading: true, error: undefined }, 0, 160 * S), false);
  const read = settle({ ...failed, loading: true, error: undefined }, { result: [1] }, 161 * S);
  assert.deepEqual(read, { loading: false, data: [1], at: 161 * S });
});

test("a result is kept until it is older than staleSeconds, also after a later call failed, and without staleSeconds while the page is open", () => {
  const read = settle(undefined, { result: [1] }, 0);
  const failed = settle({ ...read, loading: true }, { error: "x" }, 50 * S);
  assert.deepEqual(failed.data, [1]);
  assert.equal(failed.error, "x");
  // Counted from when the result was read, not from the failure.
  assert.equal(wantsRead(failed, 60, 59 * S), false);
  assert.equal(wantsRead(failed, 60, 60 * S), true);
  assert.equal(wantsRead(failed, 0, 50 * S), true);
  assert.equal(wantsRead(failed, undefined, 3600 * S), false);
  assert.equal(wantsRead(undefined, undefined, 0), true);
});
