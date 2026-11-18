import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch, type Env, runCron } from "../src/index.ts";

const DAILY = "0 20 * * *";
const env: Env = {
	DISPATCHES: {
		"*/15 * * * *": [{ repo: "4rtofl/Gasho", workflow: "release.yml", ref: "main" }],
		[DAILY]: [
			{ repo: "4rtofl/Gasho", workflow: "e2e.yml", ref: "main" },
			{ repo: "4rtofl/GashoPlugins", workflow: "e2e.yml", ref: "main", mayBeMissing: true },
		],
	},
	GITHUB_TOKEN: "token",
};

/** Answers each dispatch with the status given for its repository (204 by default), and records the URLs. */
function github(status: Record<string, number> = {}) {
	const urls: string[] = [];
	const fetcher = (async (url: string) => {
		urls.push(url);
		const repo = /repos\/([^/]+\/[^/]+)\//.exec(url)?.[1] ?? "";
		const s = status[repo] ?? 204;
		return new Response(s === 204 ? null : '{"message":"Not Found"}', { status: s });
	}) as typeof fetch;
	return { urls, fetcher };
}

test("dispatches the workflow on the branch with the token", async () => {
	const calls: { url: string; init: RequestInit }[] = [];
	await dispatch({ repo: "4rtofl/Gasho", workflow: "release.yml", ref: "main" }, "token", (async (url: string, init: RequestInit) => {
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
		dispatch({ repo: "4rtofl/Gasho", workflow: "release.yml", ref: "main" }, "token", (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as typeof fetch),
		/HTTP 401 .*Bad credentials/,
	);
});

test("each cron dispatches its own workflows", async () => {
	const every15 = github();
	await runCron("*/15 * * * *", env, every15.fetcher);
	assert.deepEqual(every15.urls, ["https://api.github.com/repos/4rtofl/Gasho/actions/workflows/release.yml/dispatches"]);
	const daily = github();
	await runCron(DAILY, env, daily.fetcher);
	assert.deepEqual(daily.urls.sort(), [
		"https://api.github.com/repos/4rtofl/Gasho/actions/workflows/e2e.yml/dispatches",
		"https://api.github.com/repos/4rtofl/GashoPlugins/actions/workflows/e2e.yml/dispatches",
	]);
	await assert.rejects(runCron("0 0 * * *", env, daily.fetcher), /nothing to dispatch/);
});

test("a workflow that may be missing is only logged when GitHub has none; any other failure still throws", async () => {
	const logs: string[] = [];
	await runCron(DAILY, env, github({ "4rtofl/GashoPlugins": 404 }).fetcher, (s) => logs.push(s));
	assert.deepEqual(logs, ["4rtofl/GashoPlugins has no e2e.yml yet (HTTP 404); not dispatched"]);
	await assert.rejects(runCron(DAILY, env, github({ "4rtofl/GashoPlugins": 401 }).fetcher, () => undefined), /GashoPlugins e2e.yml failed: HTTP 401/);
	// Gasho's own is not one that may be missing: the other is still dispatched, and the cron fails.
	const both = github({ "4rtofl/Gasho": 404 });
	await assert.rejects(runCron(DAILY, env, both.fetcher, () => undefined), /4rtofl\/Gasho e2e.yml failed: HTTP 404/);
	assert.equal(both.urls.length, 2);
});
