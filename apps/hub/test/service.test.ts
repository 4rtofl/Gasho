// `service install` on macOS, run against a fake launchctl that behaves as the one in #87: bootout returns while the
// old agent is still registered, and bootstrap fails with 5 (Input/output error) until launchd has let it go.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { activateCommands, LAUNCHD_BOOTSTRAP_RETRIES } from "../src/service.ts";

const FAKE_LAUNCHCTL = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
left=$(cat "$dir/left" 2>/dev/null || echo 0)
fails=$(cat "$dir/fails" 2>/dev/null || echo 0)
case "$1" in
  bootout) exit 0 ;;
  print)
    if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$dir/left"; exit 0; fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap)
    if [ "$left" -gt 0 ] || [ "$fails" -gt 0 ]; then
      [ "$fails" -gt 0 ] && echo $((fails - 1)) > "$dir/fails"
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    exit 0 ;;
esac
`;

/**
 * Runs the commands as `service install` does (apps/hub/src/cli.ts), with the fake launchctl first on PATH. `left`:
 * how many more `launchctl print` find the old agent; `fails`: how many bootstraps fail anyway.
 */
function install(o: { left: number; fails: number }): { calls: string[]; error?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-launchd-"));
  try {
    fs.writeFileSync(path.join(dir, "launchctl"), FAKE_LAUNCHCTL, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "left"), String(o.left));
    fs.writeFileSync(path.join(dir, "fails"), String(o.fails));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
    let error: string | undefined;
    for (const step of activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.hub.plist", 501, true)) {
      try {
        execFileSync(step.argv[0] ?? "", step.argv.slice(1), { stdio: step.mayFail ? "ignore" : "pipe", env });
      } catch (e) {
        if (!step.mayFail) {
          error = String((e as { stderr?: unknown }).stderr ?? e);
          break;
        }
      }
    }
    const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
    return { calls, ...(error === undefined ? {} : { error }) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BOOTSTRAP = "bootstrap gui/501 /Users/u/Library/LaunchAgents/local.gasho.hub.plist";
const PRINT = "print gui/501/local.gasho.hub";

test("bootstrap waits until launchd has let the old agent go after bootout (#87)", () => {
  const { calls, error } = install({ left: 3, fails: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(calls, ["bootout gui/501/local.gasho.hub", PRINT, PRINT, PRINT, PRINT, BOOTSTRAP]);
});

test("an agent that was not loaded is bootstrapped at once", () => {
  const { calls, error } = install({ left: 0, fails: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(calls, ["bootout gui/501/local.gasho.hub", PRINT, BOOTSTRAP]);
});

test("a bootstrap that fails anyway is tried again a second later", () => {
  const { calls, error } = install({ left: 0, fails: 2 });
  assert.equal(error, undefined);
  assert.deepEqual(calls.slice(2), [BOOTSTRAP, BOOTSTRAP, BOOTSTRAP]);
});

test("bootstrap gives up after its tries, with launchctl's error of the last one", () => {
  const { calls, error } = install({ left: 0, fails: 100 });
  assert.equal(calls.filter((c) => c === BOOTSTRAP).length, LAUNCHD_BOOTSTRAP_RETRIES + 1);
  assert.equal(error?.trim(), "Bootstrap failed: 5: Input/output error");
});

test("without start (another Gasho server holds the port), launchd is left alone", () => {
  assert.deepEqual(activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.hub.plist", 501, false), []);
});
