import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { codexLoginStatusOf, codexRunner, codexVersionOf, detectCodex, type RunCodex } from "../src/codex.ts";
import { loadConfig } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";

const failure = (stderr: string, code: number | string = 1) => Object.assign(new Error("failed"), { code, stderr, stdout: "" });

/** A `codex` that answers each command as given: a string is its stdout, an Error is how it fails. */
function fakeCodex(answers: { version: string | Error; login: string | Error }): RunCodex {
  return async (args) => {
    const answer = args[0] === "--version" ? answers.version : answers.login;
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: "" };
  };
}

test("the version is read from what codex --version prints", () => {
  assert.equal(codexVersionOf("codex-cli 0.170.0\n"), "0.170.0");
  assert.equal(codexVersionOf("WARNING: something\ncodex-cli 0.171.0-alpha.2\n"), "0.171.0-alpha.2");
  assert.equal(codexVersionOf("something else 1.2.3\n"), undefined);
  assert.equal(codexVersionOf(""), undefined);
});

test("only Not logged in asks for a login: another failure of the command is not known", () => {
  assert.equal(codexLoginStatusOf(failure("Not logged in\n")), "loginRequired");
  assert.equal(codexLoginStatusOf(failure("WARNING: no aliases\nNot logged in\n")), "loginRequired");
  assert.equal(codexLoginStatusOf(failure("Error loading configuration: CODEX_HOME points to /x\n")), "unknown");
  assert.equal(codexLoginStatusOf(new Error("stopped")), "unknown");
  assert.equal(codexLoginStatusOf(undefined), "unknown");
});

test("a Codex that is logged in can be used, and says its version", async () => {
  const codex = await detectCodex(fakeCodex({ version: "codex-cli 0.170.0\n", login: "" }));
  assert.deepEqual(codex, { status: "available", version: "0.170.0" });
});

test("a Codex that is not logged in says so, with its version", async () => {
  const codex = await detectCodex(fakeCodex({ version: "codex-cli 0.170.0\n", login: failure("Not logged in\n") }));
  assert.deepEqual(codex, { status: "loginRequired", version: "0.170.0" });
});

test("a Codex whose version cannot be read is still found", async () => {
  assert.deepEqual(await detectCodex(fakeCodex({ version: "?\n", login: "" })), { status: "available" });
});

test("no codex to run is not installed; one that fails to run is installed, in a state not known", async () => {
  assert.equal(await detectCodex(fakeCodex({ version: failure("", "ENOENT"), login: "" })), undefined);
  assert.deepEqual(await detectCodex(fakeCodex({ version: failure("", "EACCES"), login: "" })), { status: "unknown" });
  assert.deepEqual(await detectCodex(fakeCodex({ version: failure("broken"), login: "" })), { status: "unknown" });
});

test("the commands are run for real: their exit codes and stderr decide the state", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gasho-codex-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const script = async (name: string, login: string) => {
    const file = path.join(dir, name);
    await fsp.writeFile(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.169.1"; exit 0; fi\n${login}\n`, { mode: 0o755 });
    return codexRunner(file);
  };
  assert.deepEqual(await detectCodex(await script("in", 'echo "Logged in using ChatGPT" >&2; exit 0')), { status: "available", version: "0.169.1" });
  assert.deepEqual(await detectCodex(await script("out", 'echo "Not logged in" >&2; exit 1')), { status: "loginRequired", version: "0.169.1" });
  assert.deepEqual(await detectCodex(await script("bad", 'echo "Error loading configuration" >&2; exit 1')), { status: "unknown", version: "0.169.1" });
  assert.equal(await detectCodex(codexRunner(path.join(dir, "missing"))), undefined);
});

test("GASHO_CODEX_BIN says where codex is; without it, or empty, it is looked for on PATH", () => {
  const creds = { server: "http://127.0.0.1:1", machineId: "m", token: "t", name: "ubuntu" };
  assert.equal(loadConfig(creds, { GASHO_CODEX_BIN: "/opt/codex/bin/codex" }).codexBin, "/opt/codex/bin/codex");
  assert.equal(loadConfig(creds, { GASHO_CODEX_BIN: "" }).codexBin, "codex");
  assert.equal(loadConfig(creds, {}).codexBin, "codex");
});

test("Codex status checks never start an app-server to discover models", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gasho-codex-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "codex");
  await fsp.writeFile(bin, '#!/bin/sh\ncase "$*" in --version) echo "codex-cli 0.170.0";; "login status") exit 0;; *) exit 1;; esac\n', { mode: 0o755 });
  const creds = { server: "http://127.0.0.1:1", machineId: "m", token: "t", name: "ubuntu" };
  const daemon = new Daemon(loadConfig(creds, {
    GASHO_CODEX_BIN: bin, GASHO_AGY_BIN: "/dev/null/agy", GASHO_DAEMON_CONFIG: path.join(dir, "daemon.json"),
    XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
  })) as unknown as {
    refreshCodex(): Promise<void>;
    startCodexAppServer(): Promise<string>;
    agentsFound(): { codex?: { status: string; launchCatalog?: unknown } };
  };
  const start = t.mock.method(daemon, "startCodexAppServer", async () => assert.fail("app-server must stay stopped"));
  await daemon.refreshCodex();
  await daemon.refreshCodex();
  assert.equal(daemon.agentsFound().codex?.status, "available");
  assert.equal(daemon.agentsFound().codex?.launchCatalog, undefined);
  assert.equal(start.mock.callCount(), 0);
});
