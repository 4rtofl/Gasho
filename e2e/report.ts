// After a failed run of the end-to-end tests on GitHub Actions (.github/workflows/e2e.yml): an issue (label bug) for
// each test that failed, with the run's URL. A test that has an open issue already gets a comment on it instead, so
// that a test failing day after day stays one issue. Reads Playwright's JSON report (e2e/results.json); a run that
// ended without one (npm ci or the build failed) is reported as one that could not run the tests.
// Run with gh logged in (GH_TOKEN, GH_REPO), and GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_RUN_ID as Actions sets
// them. GH_BIN: another gh (the tests give a fake).
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const LABEL = "bug";
const MAX_ERROR = 3000;

export interface ReportTest {
  projectName: string;
  status: "expected" | "unexpected" | "flaky" | "skipped";
  results: { error?: { message?: string } }[];
}
interface ReportSpec {
  title: string;
  file: string;
  tests: ReportTest[];
}
interface ReportSuite {
  title: string;
  specs?: ReportSpec[];
  suites?: ReportSuite[];
}
export interface Report {
  suites?: ReportSuite[];
  errors?: { message?: string }[];
}

export interface Failure {
  /** "session-input.spec.ts › <title>": the file, the describe blocks and the test. */
  name: string;
  projects: string[];
  error: string;
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The tests that failed (in every project they failed in); a test that passed when tried again (flaky) is not. */
export function failures(report: Report): Failure[] {
  const out = new Map<string, Failure>();
  const walk = (suite: ReportSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status !== "unexpected") continue;
        const name = [path.basename(spec.file), ...titles, spec.title].join(" › ");
        const f = out.get(name) ?? { name, projects: [], error: "" };
        f.projects.push(t.projectName);
        f.error ||= plain(t.results.at(-1)?.error?.message ?? "");
        out.set(name, f);
      }
    }
    // The top suite of a file is titled after the file, which the name has already.
    for (const s of suite.suites ?? []) walk(s, [...titles, s.title]);
  };
  for (const s of report.suites ?? []) walk(s, []);
  return [...out.values()];
}

export function issueTitle(name: string): string {
  return `E2E のテストが落ちた: ${name}`;
}

/** The title of the issue for a run that could not run the tests (no report, or Playwright stopped before them). */
export const NOT_RUN_TITLE = "E2E のテストを最後まで流せなかった";

function body(lines: string[], error: string): string {
  const shown = error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR)}\n…` : error;
  return [
    ...lines,
    "",
    "trace・スクリーンショット・動画は、run の artifact（`e2e-results`）にある。",
    ...(shown ? ["", "<details><summary>エラー</summary>", "", "```", shown, "```", "", "</details>"] : []),
    "",
  ].join("\n");
}

type Gh = (args: string[]) => Promise<string>;

/** Opens an issue titled `title`, or comments on the open one that has the title. */
async function tell(gh: Gh, open: { number: number; title: string }[], title: string, text: string, log: (s: string) => void): Promise<void> {
  const found = open.find((i) => i.title === title);
  if (found) {
    await gh(["issue", "comment", String(found.number), "--body", text]);
    log(`commented on #${found.number}: ${title}`);
  } else {
    const url = (await gh(["issue", "create", "--title", title, "--label", LABEL, "--body", text])).trim();
    log(`opened ${url}: ${title}`);
  }
}

export async function reportFailures(o: { report: Report | undefined; runUrl: string; gh: Gh; log?: (s: string) => void }): Promise<void> {
  const log = o.log ?? console.log;
  const open = JSON.parse(await o.gh(["issue", "list", "--state", "open", "--label", LABEL, "--limit", "1000", "--json", "number,title"])) as {
    number: number;
    title: string;
  }[];
  const failed = o.report ? failures(o.report) : [];
  if (failed.length === 0) {
    // Nothing failed by name, yet the run failed: it stopped before the tests, or Playwright itself failed.
    const error = (o.report?.errors ?? []).map((e) => plain(e.message ?? "")).join("\n\n");
    await tell(o.gh, open, NOT_RUN_TITLE, body(["E2E（`e2e.yml`）を最後まで流せなかった。", "", `- run: ${o.runUrl}`], error), log);
    return;
  }
  for (const f of failed) {
    const text = body(["E2E（`e2e.yml`）で、次のテストが落ちた。", "", `- テスト: ${f.name}`, `- ブラウザー: ${f.projects.join("、")}`, `- run: ${o.runUrl}`], f.error);
    await tell(o.gh, open, issueTitle(f.name), text, log);
  }
}

if (import.meta.main) {
  const file = process.argv[2] ?? path.join(import.meta.dirname, "results.json");
  const report = await fs
    .readFile(file, "utf8")
    .then((t) => JSON.parse(t) as Report)
    .catch(() => undefined);
  const env = process.env;
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const bin = env.GH_BIN || "gh";
  await reportFailures({ report, runUrl, gh: async (args) => (await execFileP(bin, args, { maxBuffer: 16 * 1024 * 1024 })).stdout });
}
