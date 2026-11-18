// e2e/report.ts as the E2E workflow runs it after a failure, with the fake gh: an issue for each test that failed, a
// comment where one is open already, and an issue for a run that never got to the tests.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { FakeCommand } from "./harness/fakes.ts";
import { issueTitle, NOT_RUN_TITLE, type Report, type ReportTest } from "./report.ts";

const execFileP = promisify(execFile);
const RUN = "https://github.com/4rtofl/Gasho/actions/runs/42";

const spec = (title: string, project: string, status: ReportTest["status"], message?: string) => ({
  title,
  file: "session-input.spec.ts",
  tests: [{ projectName: project, status, results: [{ ...(message ? { error: { message } } : {}) }] }],
});

async function run(report: Report | undefined, open: { number: number; title: string }[]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-report-"));
  try {
    const gh = new FakeCommand("gh", home);
    await gh.set({
      answers: [
        { args: ["issue", "list"], stdout: JSON.stringify(open) },
        { args: ["issue", "create"], stdout: "https://github.com/4rtofl/Gasho/issues/200\n" },
        { args: ["issue", "comment"] },
      ],
    });
    const file = path.join(home, "results.json");
    if (report) await fs.writeFile(file, JSON.stringify(report));
    await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(import.meta.dirname, "report.ts"), file], {
      env: { ...process.env, HOME: home, GH_BIN: gh.bin, GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "4rtofl/Gasho", GITHUB_RUN_ID: "42" },
    });
    return (await gh.calls()).map((c) => c.args).filter((a) => a[1] !== "list");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

const valueOf = (args: string[] | undefined, flag: string) => args?.[args.indexOf(flag) + 1] ?? "";

test("each test that failed gets an issue, or a comment on its open one; passed and flaky ones get nothing", async () => {
  const report: Report = {
    suites: [
      {
        title: "session-input.spec.ts",
        specs: [
          spec("opens a session", "chromium", "expected"),
          spec("sends an input", "chromium", "unexpected", "\x1b[31mError: expect(locator).toBeVisible() failed\x1b[39m"),
          spec("sends an input", "webkit", "unexpected", "Error: timed out"),
          spec("retried", "webkit", "flaky"),
        ],
        suites: [{ title: "offline", specs: [spec("shows the machine as offline", "webkit", "unexpected", "Error: no")] }],
      },
    ],
    errors: [],
  };
  const sends = issueTitle("session-input.spec.ts › sends an input");
  const offline = issueTitle("session-input.spec.ts › offline › shows the machine as offline");
  const calls = await run(report, [{ number: 7, title: offline }]);
  assert.equal(calls.length, 2);
  const [create, comment] = calls;
  assert.deepEqual(create?.slice(0, 2), ["issue", "create"]);
  assert.equal(valueOf(create, "--title"), sends);
  assert.equal(valueOf(create, "--label"), "bug");
  const text = valueOf(create, "--body");
  assert.match(text, /ブラウザー: chromium、webkit/);
  assert.ok(text.includes(RUN));
  // The error as Playwright wrote it, without its colors.
  assert.ok(text.includes("Error: expect(locator).toBeVisible() failed\n"));
  assert.deepEqual(comment?.slice(0, 3), ["issue", "comment", "7"]);
  assert.ok(valueOf(comment, "--body").includes(RUN));
});

test("a run without a report (npm ci or the build failed) is reported as one that could not run the tests", async () => {
  const calls = await run(undefined, []);
  assert.equal(calls.length, 1);
  assert.equal(valueOf(calls[0], "--title"), NOT_RUN_TITLE);
  assert.ok(valueOf(calls[0], "--body").includes(RUN));
});
