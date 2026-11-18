// Whether Claude Code can be used, from its own commands. What `claude auth status` says of the person stays out of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeStatusOf, claudeVersionOf, detectClaude, type RunClaude } from "../src/claude-status.ts";

const failure = (stdout: string, code: number | string = 1) => Object.assign(new Error("failed"), { code, stdout, stderr: "" });
const status = (loggedIn: boolean) => JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "someone@example.com", orgName: "組織" });

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

test("the login is read from the JSON's loggedIn alone", () => {
  assert.equal(claudeStatusOf(status(true)), "available");
  assert.equal(claudeStatusOf(status(false)), "loginRequired");
  assert.equal(claudeStatusOf("{}"), "unknown");
  assert.equal(claudeStatusOf("not json"), "unknown");
  assert.equal(claudeStatusOf(undefined), "unknown");
});

test("logged in: it can be used, and nothing about the person is kept", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.1.327 (Claude Code)\n", auth: status(true) })), { status: "available", version: "2.1.327" });
});

test("not logged in: the command ends with an error, and its output still says so", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.1.327 (Claude Code)\n", auth: failure(status(false)) })), { status: "loginRequired", version: "2.1.327" });
});

test("a claude that cannot be run, or too old to say, is in a state not known", async () => {
  assert.deepEqual(await detectClaude(fakeClaude({ version: failure("", "ENOENT"), auth: "" })), { status: "unknown" });
  assert.deepEqual(await detectClaude(fakeClaude({ version: "2.0.0 (Claude Code)\n", auth: failure("") })), { status: "unknown", version: "2.0.0" });
});
