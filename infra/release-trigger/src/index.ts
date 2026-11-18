// Runs GitHub Actions workflows by workflow_dispatch on Cloudflare's Cron Triggers: Gasho's Release workflow
// (.github/workflows/release.yml) every 15 minutes, and the end-to-end tests of Gasho and GashoPlugins (e2e.yml) once a
// day. GitHub Actions' own schedule did not fire, so Cloudflare keeps the rhythm instead. Whether anything gets
// published is still decided by scripts/release.ts in the workflow; this Worker only starts the workflows.

/** A workflow to dispatch. */
export interface Dispatch {
	repo: string; // owner/repo
	workflow: string; // the workflow's file name or ID
	ref: string; // the branch the workflow runs on
	/** A workflow that may not be there yet: GitHub's 404 is logged, not a failure. */
	mayBeMissing?: boolean;
}

export interface Env {
	/** What each Cron Trigger dispatches, by its expression (triggers.crons in wrangler.jsonc). */
	DISPATCHES: Record<string, Dispatch[]>;
	GITHUB_TOKEN: string; // fine-grained PAT with Actions: Read and write on the repositories
}

/** Dispatches the workflow; "missing" when it is not there and may not be. Throws with GitHub's answer otherwise. */
export async function dispatch(d: Dispatch, token: string, fetcher: typeof fetch = fetch): Promise<"dispatched" | "missing"> {
	const url = `https://api.github.com/repos/${d.repo}/actions/workflows/${d.workflow}/dispatches`;
	const res = await fetcher(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "gasho-release-trigger",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({ ref: d.ref }),
	});
	// 204 when the run was queued (200 with the run's details when the API is asked for them).
	if (res.status === 204 || res.status === 200) return "dispatched";
	if (res.status === 404 && d.mayBeMissing) return "missing";
	const text = (await res.text()).slice(0, 500);
	throw new Error(`workflow_dispatch of ${d.repo} ${d.workflow} failed: HTTP ${res.status} ${text}`);
}

/**
 * Dispatches every workflow of the cron, each whatever happens to the others. Throwing marks the cron invocation as
 * failed in Cloudflare's logs and metrics.
 */
export async function runCron(cron: string, env: Env, fetcher: typeof fetch = fetch, log: (s: string) => void = console.log): Promise<void> {
	const targets = env.DISPATCHES[cron];
	if (!targets?.length) throw new Error(`nothing to dispatch for the cron "${cron}" (DISPATCHES in wrangler.jsonc)`);
	const results = await Promise.allSettled(targets.map((d) => dispatch(d, env.GITHUB_TOKEN, fetcher)));
	const errors: string[] = [];
	results.forEach((r, i) => {
		const d = targets[i]!;
		if (r.status === "rejected") errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
		else if (r.value === "missing") log(`${d.repo} has no ${d.workflow} yet (HTTP 404); not dispatched`);
	});
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

export default {
	async scheduled(controller: { cron: string }, env: Env): Promise<void> {
		await runCron(controller.cron, env);
	},
};
