import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hooksConfig, installedHookEvents, installHooks, startHookServer, summarizeHook } from "../src/hooks.ts";

type Group = { hooks: Array<Record<string, unknown>> };

test("summarizeHook keeps the command, the notification type and the last message", () => {
  assert.deepEqual(
    summarizeHook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd: "/r",
        tool_name: "Bash",
        tool_input: { command: "touch perm-1.txt", description: "Create" },
      },
      1,
    ),
    { sessionId: "s1", event: "PreToolUse", at: 1, cwd: "/r", toolName: "Bash", summary: "touch perm-1.txt" },
  );
  const n = summarizeHook({
    hook_event_name: "Notification",
    session_id: "s1",
    notification_type: "permission_prompt",
    message: "Claude needs your permission",
  });
  assert.equal(n?.notificationType, "permission_prompt");
  assert.equal(n?.summary, "Claude needs your permission");
  const stop = summarizeHook({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "了解" });
  assert.equal(stop?.summary, "了解");
  assert.equal(summarizeHook({ session_id: "s1" }), null);
});

test("summarizeHook marks the prompts Claude Code submits by itself (#91)", () => {
  const prompt = (text: string) => summarizeHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: text });
  assert.equal(prompt("<task-notification>\n<task-id>b1</task-id>")?.automatic, true);
  assert.equal(prompt('<agent-message from="a1">done</agent-message>')?.automatic, true);
  assert.equal(prompt('<cross-session-message from="uds:/x.sock" from-name="x">hi')?.automatic, true);
  assert.equal(prompt("テストを流して")?.automatic, undefined);
  assert.equal(prompt('\n\n<pasted_content id="ab12">\n<task-notification>')?.automatic, undefined);
});

test("hooksConfig registers http hooks with a literal secret header and leaves out SessionStart", () => {
  const cfg = hooksConfig(7741, "s3cret");
  assert.ok(!("SessionStart" in cfg));
  // A permission request waits for an answer from Gasho, so it gets a long timeout of its own.
  assert.equal((cfg.PermissionRequest as Group[])[0]?.hooks[0]?.timeout, 3600);
  assert.equal((cfg.Stop as Group[])[0]?.hooks[0]?.timeout, 5);
  const handler = (cfg.Stop as Group[])[0]?.hooks[0];
  assert.equal(handler?.type, "http");
  assert.equal(handler?.url, "http://127.0.0.1:7741/hooks");
  assert.deepEqual(handler?.headers, { "x-gasho-secret": "s3cret" });
  const noSecret = (hooksConfig(7741).Stop as Group[])[0]?.hooks[0];
  assert.equal(noSecret?.headers, undefined);
});

test("installHooks keeps other settings and hooks, and does not duplicate its own", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-test-"));
  try {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(
      file,
      JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );
    const backup = await installHooks(file, 7741);
    await installHooks(file, 7741);
    const s = JSON.parse(await fs.readFile(file, "utf8")) as { theme: string; hooks: Record<string, Group[]> };
    assert.equal(s.theme, "dark");
    assert.equal(s.hooks.Stop?.length, 2);
    assert.equal(s.hooks.Stop?.[0]?.hooks[0]?.command, "echo hi");
    assert.equal(s.hooks.UserPromptSubmit?.length, 1);
    assert.ok(backup && (await fs.readFile(backup, "utf8")).includes("echo hi"));
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("hook server answers 200 at once and rejects a wrong secret", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = startHookServer({ host: "127.0.0.1", port: 0, secret: "s3cret", onEvent: (p) => received.push(p) });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const url = `http://127.0.0.1:${port}/hooks`;
    const body = JSON.stringify({ hook_event_name: "Stop", session_id: "s1" });
    const bad = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-gasho-secret": "nope" } });
    assert.equal(bad.status, 401);
    const ok = await fetch(url, { method: "POST", body, headers: { "content-type": "application/json", "x-gasho-secret": "s3cret" } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.hook_event_name, "Stop");
  } finally {
    server.close();
  }
});

test("hook server refuses what a web page in a browser can send: an Origin, or a body that is not JSON (#99)", async () => {
  const received: Array<Record<string, unknown>> = [];
  const server = startHookServer({ host: "127.0.0.1", port: 0, secret: undefined, onEvent: (p) => received.push(p) });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    const body = JSON.stringify({ hook_event_name: "Notification", session_id: "s1", message: "x" });
    for (const path of ["/hooks", "/statusline"]) {
      const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers });
      assert.equal((await post({ "content-type": "application/json", origin: "https://example.com" })).status, 403);
      assert.equal((await post({ "content-type": "application/json", origin: "null" })).status, 403);
      assert.equal((await post({ "content-type": "text/plain" })).status, 415);
      assert.equal((await post({ "content-type": "application/x-www-form-urlencoded" })).status, 415);
    }
    // JSON without Origin, as Claude Code sends it; the type's case and parameters do not matter.
    assert.equal((await fetch(`http://127.0.0.1:${port}/hooks`, { method: "POST", body, headers: { "content-type": "Application/JSON; charset=utf-8" } })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test("installedHookEvents lists the events sent to Gasho, so an install without PermissionRequest can be told apart", () => {
  const ours = { type: "http", url: "http://127.0.0.1:7741/hooks" };
  const text = JSON.stringify({
    hooks: { Stop: [{ hooks: [ours] }], PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }], Notification: [{ hooks: [ours] }] },
  });
  assert.deepEqual(installedHookEvents(text, 7741), ["Stop", "Notification"]);
  assert.deepEqual(installedHookEvents(JSON.stringify({ hooks: hooksConfig(7741) }), 7741).includes("PermissionRequest"), true);
  assert.deepEqual(installedHookEvents("not json", 7741), []);
});
