// Whether Claude Code can be used, from its own commands. Email and organization details stay out of it.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonToHub, ModelOption } from "@gasho/protocol";
import { claudeAuthOf, claudeVersionOf, detectClaude, type RunClaude } from "../src/claude-status.ts";
import { Daemon } from "../src/daemon.ts";

const failure = (stdout: string, code: number | string = 1) => Object.assign(new Error("failed"), { code, stdout, stderr: "" });
const status = (loggedIn: boolean, subscriptionType?: unknown) => JSON.stringify({ loggedIn, subscriptionType, authMethod: "claude.ai", email: "someone@example.com", orgName: "組織" });

function fakeClaude(answers: { version: string | Error; auth: string | Error }): RunClaude {
  return async (args) => {
    const answer = args[0] === "--version" ? answers.version : answers.auth;
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: "" };
  };
}

test("the version is read from what claude --version prints", () => {
  assert.equal(claudeVersionOf("2.1.327 (Claude Code)\n"), "2.1.327");
  assert.equal(claudeVersionOf("something else 1.2.3\n"), undefined);
});

test("auth status keeps only login and a reported subscription type", () => {
  assert.deepEqual(claudeAuthOf(status(true, "pro")), { status: "available", subscriptionType: "pro" });
  assert.deepEqual(claudeAuthOf(status(true, "max")), { status: "available", subscriptionType: "max" });
  assert.deepEqual(claudeAuthOf(status(true, null)), { status: "available" });
  assert.deepEqual(claudeAuthOf(status(true)), { status: "available" });
  assert.deepEqual(claudeAuthOf(status(false, "pro")), { status: "loginRequired" });
  assert.deepEqual(claudeAuthOf("{}"), { status: "unknown" });
  assert.deepEqual(claudeAuthOf("not json"), { status: "unknown" });
  assert.deepEqual(claudeAuthOf(undefined), { status: "unknown" });
});

test("logged in: it can be used, and nothing about the person is kept", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.1.327 (Claude Code)\n", auth: status(true, "pro") })), { status: "available", subscriptionType: "pro", version: "2.1.327" });
});

test("not logged in: the command ends with an error, and its output still says so", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.1.327 (Claude Code)\n", auth: failure(status(false)) })), { status: "loginRequired", version: "2.1.327" });
});

test("a claude that cannot be run, or too old to say, is in a state not known", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: failure("", "ENOENT"), auth: "" })), { status: "unknown" });
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.0.0 (Claude Code)\n", auth: failure("") })), { status: "unknown", version: "2.0.0" });
});

test("refreshClaude sends the model catalog again when the subscription changes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-claude-status-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claude = path.join(dir, "claude");
  const auth = path.join(dir, "auth.json");
  await fs.writeFile(claude, '#!/bin/sh\nif [ "$1" = --version ]; then\n  echo "2.1.332 (Claude Code)"\nelse\n  cat "$(dirname "$0")/auth.json"\nfi\n', { mode: 0o755 });
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir: path.join(dir, "claude-dir"),
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    claudeTmpDir: path.join(dir, "claude-tmp"),
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  const options: ModelOption[] = [
    { id: "opus", name: "Opus 5.5" },
    { id: "fable", name: "Fable 5.2" },
  ];
  d.models = { at: Date.now(), options };
  const capabilities: Extract<DaemonToHub, { type: "capabilities" }>[] = [];
  d.hub = {
    connected: true,
    send: (message: DaemonToHub) => {
      if (message.type === "capabilities") capabilities.push(message);
    },
  };

  await fs.writeFile(auth, status(true, "pro"));
  await d.refreshClaude();
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0]?.claudeSubscriptionType, "pro");
  assert.deepEqual(capabilities[0]?.models, [options[0]]);
  assert.ok(capabilities[0]?.agents?.claude);
  assert.ok(!("subscriptionType" in capabilities[0].agents.claude));

  await fs.writeFile(auth, status(true, "max"));
  await d.refreshClaude();
  assert.equal(capabilities.length, 2);
  assert.equal(capabilities[1]?.claudeSubscriptionType, "max");
  assert.deepEqual(capabilities[1]?.models, options);
  assert.deepEqual(capabilities[1]?.agents?.claude, capabilities[0].agents.claude);
});
