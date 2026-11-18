import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@gasho/protocol";
import {
  branchLabel,
  clockTime,
  elapsedTime,
  formatCost,
  githubCommitUrl,
  githubTreeUrl,
  relativeTime,
  repoLabel,
  sessionLabel,
  waitingText,
} from "../src/lib/format.ts";

test("how long something has been going on: seconds, minutes, hours and minutes, days", () => {
  const now = Date.parse("2026-11-14T16:00:00Z");
  assert.equal(elapsedTime(now - 40_000, now), "40秒");
  assert.equal(elapsedTime(now - 12 * 60_000 - 5_000, now), "12分");
  assert.equal(elapsedTime(now - 65 * 60_000, now), "1時間5分");
  assert.equal(elapsedTime(now - 2 * 3600_000, now), "2時間");
  assert.equal(elapsedTime(now - 50 * 3600_000, now), "2日");
  // A clock a little ahead on the working server.
  assert.equal(elapsedTime(now + 3_000, now), "0秒");
});

test("how long ago something was: just now within 45 seconds, then minutes, hours and days, ahead or behind", () => {
  const now = Date.parse("2026-11-14T16:00:00Z");
  assert.equal(relativeTime(undefined, now), "-");
  assert.equal(relativeTime(0, now), "-");
  assert.equal(relativeTime(now - 44_000, now), "たった今");
  assert.equal(relativeTime(now + 44_000, now), "たった今");
  assert.equal(relativeTime(now - 46_000, now), "1 分前");
  assert.equal(relativeTime(now - 59 * 60_000, now), "59 分前");
  assert.equal(relativeTime(now - 61 * 60_000, now), "1 時間前");
  assert.equal(relativeTime(now + 2 * 3600_000, now), "2 時間後");
  assert.equal(relativeTime(now - 25 * 3600_000, now), "昨日");
  assert.equal(relativeTime(now - 3 * 86400_000, now), "3 日前");
});

test("a time of day is shown as hours and minutes, and nothing for a time that is not one", () => {
  assert.match(clockTime("2026-11-14T16:05:00Z"), /^\d{2}:\d{2}$/);
  assert.equal(clockTime(undefined), "");
  assert.equal(clockTime("not a time"), "");
});

const session = (s: Partial<SessionInfo>): SessionInfo => ({ sessionId: "0123456789abcdef", cwd: "/src/app", status: "waiting", rcMode: "none", prLinks: [], ...s }) as SessionInfo;

test("what a waiting session waits for: Claude's question or plan when Gasho holds it, else what claude agents says", () => {
  const ask = (toolName: string) => ({ id: "p", toolName }) as NonNullable<SessionInfo["permissionRequests"]>[number];
  assert.equal(waitingText(session({ permissionRequests: [ask("Bash"), ask("AskUserQuestion")] })), "質問への回答を待っています");
  assert.equal(waitingText(session({ permissionRequests: [ask("ExitPlanMode")] })), "計画の承認を待っています");
  assert.equal(waitingText(session({ permissionRequests: [ask("Bash")], waitingFor: "permission prompt" })), "権限の確認");
  assert.equal(waitingText(session({ waitingFor: "input needed" })), "回答待ち");
  assert.equal(waitingText(session({ waitingFor: "something new" })), "something new");
  assert.equal(waitingText(session({})), "確認を待っています");
});

test("a session is named by the name given in Gasho, then its title, its name, its folder, or the start of its id", () => {
  assert.equal(sessionLabel(session({ managed: true, name: "review", title: "Fix the bug" })), "review");
  assert.equal(sessionLabel(session({ name: "review", title: "Fix the bug" })), "Fix the bug");
  assert.equal(sessionLabel(session({ name: "review" })), "review");
  assert.equal(sessionLabel(session({})), "app");
  assert.equal(sessionLabel(session({ cwd: "" })), "01234567");
});

test("the repository is owner/name on GitHub, else the folder; HEAD outside a repository is no branch", () => {
  const github = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };
  assert.equal(repoLabel(session({ github })), "4rtofl/Gasho");
  assert.equal(repoLabel(session({ cwd: "/src/app/" })), "app");
  assert.equal(branchLabel(session({ gitBranch: "HEAD" })), undefined);
  assert.equal(branchLabel(session({ gitBranch: "HEAD", github })), "HEAD");
  assert.equal(branchLabel(session({ gitBranch: "feat/x" })), "feat/x");
  assert.equal(branchLabel(session({})), undefined);
});

test("links to a branch and a commit on GitHub keep a branch's slashes and encode the rest", () => {
  const repo = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };
  assert.equal(githubTreeUrl(repo, "feat/126-unit tests#1"), "https://github.com/4rtofl/Gasho/tree/feat/126-unit%20tests%231");
  assert.equal(githubCommitUrl(repo, "f56b3ce"), "https://github.com/4rtofl/Gasho/commit/f56b3ce");
  assert.equal(formatCost(1.005), "$1.00");
  assert.equal(formatCost(undefined), undefined);
});
