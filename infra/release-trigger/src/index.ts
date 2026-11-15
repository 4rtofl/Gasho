// Runs the Release workflow of Gasho (.github/workflows/release.yml) by workflow_dispatch on every Cron Trigger.
// GitHub Actions' own schedule did not fire, so Cloudflare keeps the 15-minute rhythm instead. Whether anything gets
// published is still decided by scripts/release.ts in the workflow; this Worker only starts it.

export interface Env {
	GITHUB_REPOSITORY: string; // owner/repo
	GITHUB_WORKFLOW: string; // the workflow's file name or ID
	GITHUB_REF: string; // the branch the workflow runs on
	GITHUB_TOKEN: string; // fine-grained PAT with Actions: Read and write on the repository
}

export async function dispatch(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
	const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
	const res = await fetcher(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"Content-Type": "application/json",
			"User-Agent": "gasho-release-trigger",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body: JSON.stringify({ ref: env.GITHUB_REF }),
	});
	// 204 when the run was queued (200 with the run's details when the API is asked for them).
	if (res.status !== 204 && res.status !== 200) {
		const text = (await res.text()).slice(0, 500);
		// Throwing marks the cron invocation as failed in Cloudflare's logs and metrics.
		throw new Error(`workflow_dispatch of ${env.GITHUB_WORKFLOW} failed: HTTP ${res.status} ${text}`);
	}
}

export default {
	async scheduled(_controller: unknown, env: Env): Promise<void> {
		await dispatch(env);
	},
};
