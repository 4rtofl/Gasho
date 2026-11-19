// Starting a session from Gasho's screen, by every way there is: the launch form, a worktree's "＋", a category's "＋" and
// a plugin's useLaunchSession. Before it starts, the person is asked once whether to remove the unused sessions of that
// working server (components/unused-sessions-dialog.tsx shows the question). Launches that come while the question is
// open wait for the same answer.
import type { AgentKind, CommandResult, SessionInfo } from "@gasho/protocol";
import { useSyncExternalStore } from "react";
import { launchAgentField } from "./agents.ts";
import { sessionLabel } from "./format.ts";
import { showNotice } from "./notice.ts";
import { parseHash } from "./route.ts";
import { getAppState, sendCommand } from "./store.ts";
import { keepsUnused, keepUnused, unusedSessions } from "./unused-sessions.ts";

/** How long to wait for a new session, a little longer than the Gasho server does. */
const LAUNCH_WAIT_MS = 60_000;
const REMOVE_WAIT_MS = 50_000;
/**
 * How long after the last launch an answer also holds for the next one (ms): a plugin that starts sessions one after
 * the other waits for each before it sends the next, and is not to raise the question again for each of them.
 */
const FOLLOW_UP_MS = 10_000;

export interface LaunchInput {
  cwd: string;
  name?: string;
  trust?: boolean;
  /** The agent to start: Claude Code when absent. */
  agent?: AgentKind;
}

/** `cancelled`: the person chose not to start it, which needs no message. */
export type LaunchOutcome = CommandResult & { cancelled?: boolean };

type Answer = "go" | "cancel";

/** The question for one working server. */
export interface UnusedQuestion {
  id: number;
  machine: string;
  sessions: SessionInfo[];
  /**
   * False once a plugin's launch waits for the answer: a plugin may have made a worktree for the session before it asks
   * for one, and a cancel would leave that behind with nothing started in it.
   */
  cancellable: boolean;
  answer: Promise<Answer>;
  settle: (answer: Answer) => void;
}

let questions: UnusedQuestion[] = [];
let lastId = 0;
const listeners = new Set<() => void>();

const setQuestions = (next: UnusedQuestion[]) => {
  questions = next;
  for (const l of listeners) l();
};

/** The question to show now. Those for other working servers wait for their turn, so that dialogs never pile up. */
export function useUnusedQuestion(): UnusedQuestion | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => questions[0],
  );
}

/** The answer to go on last given per working server, while the launches it let through run and for FOLLOW_UP_MS after them. */
interface RecentGo {
  running: number;
  until: number;
}
const recent = new Map<string, RecentGo>();

/** Launches that stopped at Claude Code's question whether to trust the folder: starting them again asks nothing more. */
const askedTrust = new Set<string>();
const trustKey = (machine: string, cwd: string) => `${machine}\u0000${cwd}`;

function openSessionOn(machine: string): string | undefined {
  const route = parseHash(location.hash);
  return route.name === "session" && route.machine === machine ? route.sessionId : undefined;
}

function unusedOn(machine: string): SessionInfo[] {
  const m = getAppState().machines.find((x) => x.id === machine);
  return m ? unusedSessions(m, Date.now(), openSessionOn(machine)) : [];
}

/** The answer to go on that still holds for a launch on this working server, if any. */
function liveGo(machine: string): RecentGo | undefined {
  const last = recent.get(machine);
  return last && (last.running > 0 || Date.now() < last.until) ? last : undefined;
}

function answerFor(machine: string, input: LaunchInput, fromPlugin: boolean): Answer | Promise<Answer> {
  if (input.trust && askedTrust.delete(trustKey(machine, input.cwd))) return "go";
  const open = questions.find((q) => q.machine === machine);
  if (open) {
    if (fromPlugin && open.cancellable) setQuestions(questions.map((q) => (q === open ? { ...q, cancellable: false } : q)));
    return open.answer;
  }
  if (liveGo(machine)) return "go";
  if (keepsUnused(machine, Date.now())) return "go";
  const sessions = unusedOn(machine);
  if (sessions.length === 0) return "go";
  let settle!: (answer: Answer) => void;
  const answer = new Promise<Answer>((resolve) => {
    settle = resolve;
  });
  const question: UnusedQuestion = { id: ++lastId, machine, sessions, cancellable: !fromPlugin, answer, settle };
  setQuestions([...questions, question]);
  return answer;
}

function finish(question: UnusedQuestion, answer: Answer): void {
  // A person who cancelled and starts again means it: only an answer to go on holds for the launches after it.
  if (answer === "go") recent.set(question.machine, { running: 0, until: Date.now() + FOLLOW_UP_MS });
  setQuestions(questions.filter((q) => q.id !== question.id));
  question.settle(answer);
}

/** "キャンセル": nothing is removed, and the launches that wait for the answer do not start. */
export function cancelLaunch(question: UnusedQuestion): void {
  if (questions.find((q) => q.id === question.id)?.cancellable) finish(question, "cancel");
}

/** "削除せずに起動": this working server is not asked about again for an hour. */
export function launchKeepingUnused(question: UnusedQuestion): void {
  keepUnused(question.machine, Date.now());
  finish(question, "go");
}

/**
 * "削除して起動": removes the sessions picked, then lets the launches go on, also when some could not be removed (the
 * screen tells which). One that was put to use while the question was open is left alone.
 */
export async function launchRemovingUnused(question: UnusedQuestion, picked: ReadonlySet<string>): Promise<void> {
  const stillUnused = new Set(unusedOn(question.machine).map((s) => s.sessionId));
  const chosen = question.sessions.filter((s) => picked.has(s.sessionId));
  const results = await Promise.all(
    chosen.map(async (s) => {
      if (!stillUnused.has(s.sessionId)) return { session: s, error: "使われ始めたため、削除しませんでした" };
      const r = await sendCommand(question.machine, { type: "session.remove", sessionId: s.sessionId }, REMOVE_WAIT_MS);
      return { session: s, error: r.ok ? undefined : (r.error ?? "削除できませんでした") };
    }),
  );
  const failed = results.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    showNotice(`削除できなかったセッションがあります。${failed.map((r) => `「${sessionLabel(r.session)}」：${r.error}`).join(" ")}`);
  }
  finish(question, "go");
}

async function launchSession(machine: string, input: LaunchInput, { fromPlugin = false } = {}): Promise<LaunchOutcome> {
  const answer = await answerFor(machine, input, fromPlugin);
  if (answer === "cancel") return { ok: false, cancelled: true, error: "セッションの起動をキャンセルしました。" };
  const held = liveGo(machine);
  if (held) held.running++;
  const r = await sendCommand(
    machine,
    { type: "session.launch", cwd: input.cwd, name: input.name, ...(input.trust ? { trust: true } : {}), ...launchAgentField(input.agent ?? "claude") },
    LAUNCH_WAIT_MS,
  );
  if (held) {
    held.running--;
    held.until = Date.now() + FOLLOW_UP_MS;
  }
  if (r.needsTrust) askedTrust.add(trustKey(machine, input.cwd));
  return r;
}

/** The one way the screen starts a session. */
export const useSessionLauncher = () => launchSession;
