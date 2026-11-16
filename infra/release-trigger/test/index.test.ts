import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, type Env } from "../src/index.ts";

const env: Env = {
	GITHUB_REPOSITORY: "4rtofl/Gasho",
	GITHUB_WORKFLOW: "release.yml",
	GITHUB_REF: "main",
	GITHUB_TOKEN: "token",
};

test("dispatches the workflow on the branch with the token", async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	await dispatch(env, (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(null, { status: 204 });
	}) as typeof fetch);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.github.com/repos/4rtofl/Gasho/actions/workflows/release.yml/dispatches");
	assert.equal(calls[0].init.method, "POST");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer token");
	assert.ok(headers["User-Agent"]);
	assert.deepEqual(JSON.parse(calls[0].init.body as string), { ref: "main" });
});

test("throws with GitHub's answer when the dispatch is refused", async () => {
	await assert.rejects(
		dispatch(env, (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch),
		/HTTP 401 .*Bad credentials/,
	);
});
