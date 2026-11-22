// Settings of this browser: the size of the conversation's text on the session screen, with a sample of a
// conversation to see it by, and its notifications (Web Push). The default agent is the Gasho server's, the same for
// every browser. Then the versions of Gasho running now. Each is a section that folds (lib/settings-sections).
import { Check, CircleAlert, Copy, Info, RotateCcw, Type } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentKind, TranscriptEntry } from "@gasho/protocol";
import { PushSettingsSection } from "@/components/push-settings";
import { TranscriptSample } from "@/components/transcript";
import { Badge } from "@/components/ui/badge";
import { AccordionSection } from "@/components/ui/unfold-accordion";
import { MorphingButton, type MorphingButtonStatus } from "@/components/ui/morphing-button";
import { AGENT_NAME, codexOffered } from "@/lib/agents";
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, CHAT_TEXT_MIN, useChatTextSize } from "@/lib/chat-text";
import { go } from "@/lib/route";
import { useSettingsSectionOpen } from "@/lib/settings-sections";
import { OWN_BUILD, setDefaultAgent, useAppState } from "@/lib/store";
import { copyToClipboard } from "@/lib/utils";
import { versionRows, versionsText } from "@/lib/versions";
import { PluginSettingsSections } from "@/plugins/parts";

const STEP =
  "grid size-9 shrink-0 place-items-center rounded-lg border border-border hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border";

/** A request, the tools Claude used for it (in one fold, as in a session), and its answer. */
const SAMPLE: TranscriptEntry[] = [
  {
    uuid: "sample-request",
    ts: "2026-11-14T00:41:00.000Z",
    role: "user",
    blocks: [{ type: "text", text: "ログインのボタンが押せないことがある。原因を調べて直して" }],
  },
  {
    uuid: "sample-tools",
    role: "assistant",
    blocks: [
      { type: "tool_use", id: "sample-read", name: "Read", input: JSON.stringify({ file_path: "src/LoginForm.tsx" }) },
      {
        type: "tool_use",
        id: "sample-edit",
        name: "Edit",
        input: JSON.stringify({ file_path: "src/LoginForm.tsx", old_string: "EMAIL.test(email)", new_string: "EMAIL.test(email.trim())" }),
      },
    ],
  },
  {
    uuid: "sample-results",
    role: "user",
    blocks: [
      { type: "tool_result", toolUseId: "sample-read", content: "export function LoginForm() { … }", isError: false },
      { type: "tool_result", toolUseId: "sample-edit", content: "The file src/LoginForm.tsx has been updated successfully.", isError: false },
    ],
  },
  {
    uuid: "sample-answer",
    role: "assistant",
    blocks: [
      {
        type: "text",
        text: [
          "原因は、ボタンを押せなくする条件でした。メールアドレスの前後に**空白**が入っていると、形式が正しくないと判定されていました。",
          "",
          "```ts",
          "const valid = EMAIL.test(email.trim());",
          "```",
          "",
          "- 前後の空白を除いてから判定するように直しました",
          "- `LoginForm` のテストを1件足しました",
        ].join("\n"),
      },
    ],
  },
];

export function SettingsView() {
  const [size, setSize] = useChatTextSize();
  const [open, setOpen] = useSettingsSectionOpen("chat-text");
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">設定</h1>
        <p className="text-sm text-muted-foreground">このブラウザで使う設定です。スマホと PC で別々に決められます。</p>
      </div>

      <AccordionSection
        icon={<Type className="size-4" />}
        title="会話の文字の大きさ"
        description="セッション画面の会話の文字です。入力欄の文字は変わりません。"
        open={open}
        onOpenChange={setOpen}
        bodyClassName="space-y-4"
        actions={
          <div className="flex items-center gap-3 text-sm">
            <span className="tabular-nums">
              {size}px{size === CHAT_TEXT_DEFAULT && <span className="text-muted-foreground">（標準）</span>}
            </span>
            {size !== CHAT_TEXT_DEFAULT && (
              <button
                type="button"
                onClick={() => setSize(CHAT_TEXT_DEFAULT)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover"
              >
                <RotateCcw className="size-3.5" />
                標準に戻す
              </button>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-3">
          <button type="button" aria-label="小さくする" title="小さくする" disabled={size <= CHAT_TEXT_MIN} onClick={() => setSize(size - 1)} className={STEP}>
            <span aria-hidden className="text-xs font-medium">
              A
            </span>
          </button>
          <input
            type="range"
            min={CHAT_TEXT_MIN}
            max={CHAT_TEXT_MAX}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.currentTarget.value))}
            aria-label="会話の文字の大きさ"
            aria-valuetext={`${size}px`}
            className="h-6 min-w-0 flex-1 cursor-pointer accent-foreground"
          />
          <button type="button" aria-label="大きくする" title="大きくする" disabled={size >= CHAT_TEXT_MAX} onClick={() => setSize(size + 1)} className={STEP}>
            <span aria-hidden className="text-lg font-medium">
              A
            </span>
          </button>
        </div>

        <div className="space-y-3 rounded-xl border border-border bg-background p-4">
          <p className="text-xs text-muted-foreground">見本</p>
          <TranscriptSample entries={SAMPLE} textSize={size} />
        </div>
      </AccordionSection>

      <DefaultAgentSection />

      <PushSettingsSection />

      {/* The settings of the enabled plugins (docs/plugins.md, P5). */}
      <PluginSettingsSections />

      <VersionsSection />
    </div>
  );
}

/** How long the copy button says how the copy went. */
const COPIED_MS = 2000;

/** The agent a new session starts with. Shown once Codex is installed on some working server. */
export function DefaultAgentSection() {
  const { server, machines } = useAppState();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useSettingsSectionOpen("default-agent");
  const current = server?.defaultAgent;
  if (!current || !machines.some(codexOffered)) return null;
  const pick = async (agent: AgentKind) => {
    setError(undefined);
    const r = await setDefaultAgent(agent);
    if (!r.ok) setError(r.error ?? "変えられませんでした。");
  };
  return (
    <AccordionSection
      title="既定のエージェント"
      description="「＋」で起動するエージェントです。どのブラウザーでも同じです。Codex を使えない working server では、Claude Code を起動します。"
      open={open}
      onOpenChange={setOpen}
    >
      <div role="radiogroup" aria-label="既定のエージェント" className="flex flex-wrap gap-2">
        {(["claude", "codex"] as const).map((agent) => (
          <button
            key={agent}
            type="button"
            role="radio"
            aria-checked={current === agent}
            onClick={() => void pick(agent)}
            className={
              current === agent
                ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                : "rounded-lg border border-border px-3 py-1.5 text-sm hover:border-border-hover"
            }
          >
            {AGENT_NAME[agent]}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </AccordionSection>
  );
}

/** The versions running now, a newer one published taking to the updates on the 端末 screen, and a copy of them all. */
function VersionsSection() {
  const { server, machines, latest } = useAppState();
  const rows = versionRows({ server, machines, latest, build: OWN_BUILD });
  // A new object for each copy, so that copying again while it says how the last one went starts the time over.
  const [copied, setCopied] = useState<{ status: MorphingButtonStatus }>({ status: "idle" });
  useEffect(() => {
    if (copied.status === "idle") return;
    const timer = setTimeout(() => setCopied({ status: "idle" }), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const openUpdates = () => go({ name: "devices", section: "updates" });
  const [open, setOpen] = useSettingsSectionOpen("versions");

  return (
    <AccordionSection
      icon={<Info className="size-4" />}
      title="バージョン"
      description="いま動いている Gasho のバージョンです。不具合を伝えるときは、まとめてコピーして貼ってください。"
      open={open}
      onOpenChange={setOpen}
      actions={
        <MorphingButton
          status={copied.status}
          idleText="バージョンをコピー"
          successText="コピーしました"
          errorText="コピーできません"
          idleIcon={<Copy className="size-3.5" />}
          successIcon={<Check className="size-3.5" />}
          errorIcon={<CircleAlert className="size-3.5" />}
          onClick={() => void copyToClipboard(versionsText(rows)).then((ok) => setCopied({ status: ok ? "success" : "error" }))}
        />
      }
    >
      <ul className="divide-y divide-border rounded-xl border border-border bg-background">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 p-3">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{r.label}</span>
              <span className="font-mono text-xs text-foreground/80">{r.value}</span>
              {r.details.map((d) => (
                <span key={d} className="text-xs text-muted-foreground">
                  {d}
                </span>
              ))}
            </p>
            {r.newer && (
              <button
                type="button"
                onClick={openUpdates}
                title="端末の画面の、更新の欄を開きます"
                className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {r.newer.updatable ? (
                  <Badge tone="success" dot>{`${r.newer.version} に更新できます`}</Badge>
                ) : (
                  <Badge dot>{`${r.newer.version} が公開されています`}</Badge>
                )}
              </button>
            )}
          </li>
        ))}
      </ul>
    </AccordionSection>
  );
}
