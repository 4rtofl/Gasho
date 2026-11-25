// Controls next to the model picker of the chat box (PromptInput's `actions`) of a session started from Gasho: the
// effort level, with ultracode in the same menu, and the button that shows or hides the list of the work running in
// the background. What is picked in the menu is switched (for this session only) when the next message is sent.
import { Check, ChevronDown, Gauge, LoaderCircle, Workflow } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useId, useRef, useState } from "react";
import type { EffortLevel, SessionModel } from "@gasho/protocol";
import { cn } from "@/lib/utils";

/**
 * The models of Claude Code's /model picker. Picking one switches the session, for this session only, before sending;
 * the settings pick the one a new session starts with. The names with their versions ("Opus 5.5") come from the
 * working server, which reads them from the picker.
 */
export const MODELS: { id: SessionModel; name: string; description: string }[] = [
  { id: "default", name: "既定", description: "Claude Code の既定（おすすめ）のモデル" },
  { id: "opus", name: "Opus", description: "複雑な作業にも、普段の作業にも" },
  { id: "fable", name: "Fable", description: "いちばん難しい課題に" },
  { id: "sonnet", name: "Sonnet", description: "簡単な作業を効率よく" },
  { id: "haiku", name: "Haiku", description: "短い質問に、いちばん速く答える" },
];

/** Claude Code's effort levels, lowest first, with its own names. */
export const EFFORTS: { id: EffortLevel; name: string; description: string }[] = [
  { id: "low", name: "Low", description: "速さを優先する" },
  { id: "medium", name: "Medium", description: "標準" },
  { id: "high", name: "High", description: "じっくり考える" },
  { id: "xhigh", name: "xHigh", description: "さらにじっくり考える" },
  { id: "max", name: "Max", description: "いちばんじっくり考える" },
];

// The same look as the model picker button of EasyUI's PromptInput (a little narrower on a phone).
const BUTTON =
  "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2 text-[13px] sm:px-2.5 font-medium text-neutral-500 transition-[color,background-color] duration-150 [-webkit-tap-highlight-color:transparent] outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40 sm:h-9 [@media(hover:hover)]:hover:bg-white/[0.07] [@media(hover:hover)]:hover:text-neutral-100";

/** A dot on a control whose choice differs from what the session uses now: it is switched when sending. */
function PendingDot() {
  return <span aria-hidden className="absolute top-1.5 right-1 size-1.5 rounded-full bg-amber-400" />;
}

/** Ultracode in the effort menu: what the session uses, and what is picked for the next message. */
export interface UltracodeChoice {
  value: boolean;
  current: boolean;
  onChange: (on: boolean) => void;
}

/**
 * The effort level, picked from a menu of radio items (one of five). With `ultracode`, the menu also turns ultracode
 * on and off (it stays open for that), and the button shows it while it is on.
 */
export function EffortPicker({
  value,
  current,
  onChange,
  ultracode,
  disabled,
}: {
  value: EffortLevel | undefined;
  current: EffortLevel | undefined;
  onChange: (effort: EffortLevel) => void;
  ultracode?: UltracodeChoice;
  disabled?: boolean;
}) {
  const selected = EFFORTS.find((e) => e.id === value);
  const effortPending = value !== undefined && value !== current;
  const ultraOn = Boolean(ultracode?.value);
  const ultraPending = ultracode !== undefined && ultracode.value !== ultracode.current;
  const pending = effortPending || ultraPending;
  const titleId = useId();
  const [open, setOpen] = useState(false);
  // A touch opens the menu on a tap, not when the finger lands: swiping the toolbar sideways must only scroll it.
  const touch = useRef(false);
  const label = `Effort：${selected?.name ?? "不明"}${ultraOn ? "・Ultracode オン" : ""}${pending ? "（送るときに切り替えます）" : ""}`;
  return (
    // Not modal: a modal menu would lock the page's scrolling under the floating chat box.
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          onPointerDown={(e) => {
            touch.current = e.pointerType !== "mouse";
            // Keeps Radix from opening the menu now.
            if (touch.current) e.preventDefault();
          }}
          onClick={() => {
            if (touch.current) setOpen((o) => !o);
            touch.current = false;
          }}
          aria-label={label}
          title={pending ? "送るときに切り替えます" : ultracode ? "Effort と Ultracode" : "Effort"}
          className={cn(BUTTON, "data-[state=open]:bg-white/[0.07] data-[state=open]:text-neutral-100")}
        >
          <Gauge className="size-4 shrink-0" />
          <span>{selected?.name ?? "Effort"}</span>
          {ultraOn && <Workflow aria-hidden className="size-3.5 shrink-0 text-violet-300" />}
          {/* On a phone the toolbar is short of room; the button still opens the menu. */}
          <ChevronDown className="hidden size-3.5 shrink-0 sm:block" />
          {pending && <PendingDot />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Named by its title (Radix would name it after the button).
          aria-labelledby={titleId}
          className="z-[100] w-64 rounded-2xl bg-popover p-1.5 text-sm shadow-xl ring-1 ring-white/[0.1]"
        >
          <DropdownMenu.Label id={titleId} className="px-2.5 pt-1 pb-1.5 text-xs text-neutral-500">
            Effort
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={value ?? ""} onValueChange={(v) => onChange(v as EffortLevel)}>
            {EFFORTS.map((e) => (
              <DropdownMenu.RadioItem key={e.id} value={e.id} className={ITEM}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-neutral-100">{e.name}</span>
                    {e.id === current && <NowBadge />}
                  </span>
                  <span className="block text-[12px] text-neutral-500">{e.description}</span>
                </span>
                <DropdownMenu.ItemIndicator>
                  <Check className="size-4 shrink-0 text-neutral-100" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {ultracode && (
            <>
              <DropdownMenu.Separator className="mx-1 my-1.5 h-px bg-white/[0.08]" />
              <DropdownMenu.CheckboxItem
                checked={ultracode.value}
                onCheckedChange={(on) => ultracode.onChange(on)}
                // Stays open: the effort level can be picked after it.
                onSelect={(e) => e.preventDefault()}
                className={ITEM}
              >
                <Workflow aria-hidden className={cn("size-4 shrink-0", ultracode.value ? "text-violet-300" : "text-neutral-500")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-neutral-100">Ultracode</span>
                    {ultracode.current && <NowBadge on />}
                  </span>
                  <span className="block text-[12px] text-neutral-500">
                    {ultraPending ? "送るときに切り替えます" : "どの作業も複数のエージェントで進める（このセッションだけ）"}
                  </span>
                </span>
                <SwitchLook on={ultracode.value} />
              </DropdownMenu.CheckboxItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const ITEM =
  "flex w-full cursor-default items-center gap-2 rounded-xl px-2.5 py-2 text-left outline-none select-none data-[highlighted]:bg-white/[0.06]";

/** Marks what the session uses now. */
function NowBadge({ on }: { on?: boolean }) {
  return <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10.5px] text-neutral-400">{on ? "いまオン" : "いま"}</span>;
}

/** A switch drawn in a menu item, which itself is the checkbox (menuitemcheckbox). */
function SwitchLook({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150", on ? "bg-violet-500" : "bg-white/[0.12]")}
    >
      <span className={cn("size-4 rounded-full bg-white shadow-sm transition-transform duration-150", on ? "translate-x-4" : "translate-x-0")} />
    </span>
  );
}

/**
 * Shows or hides the list of the work running in the background above the chat box. Only there while something runs;
 * it says how many.
 */
export function BackgroundToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      aria-label={`バックグラウンドで実行中（${count} 件）`}
      aria-pressed={open}
      title={open ? "バックグラウンドで実行中の一覧を隠す" : "バックグラウンドで実行中の一覧を出す"}
      onClick={onToggle}
      className={cn(BUTTON, open && "bg-white/[0.07] text-neutral-100")}
    >
      <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-sky-400 motion-reduce:animate-none" />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
