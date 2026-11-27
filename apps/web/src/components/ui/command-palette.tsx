// EasyUI's Spotlight Search (easyui.site/components/spotlight-search): a search box over what can be opened and done
// on the screen, opened with ⌘K, whose one highlight glides to the row picked with ↑↓ or the mouse, Enter running it.
// Changed for Gasho: the rows are under the headings of their groups, with an icon, a second line and, at the right,
// the keys of their shortcut, as EasyUI's Command Menu (easyui.site/components/command-menu) shows them, with its line
// of keys under the list; a row can be unusable for now, and tells why; every word typed must match; the highlight is
// measured as in Combobox (combobox-list.tsx), so that it follows the list's scroll and the list scrolls to it; Radix
// Dialog keeps the focus inside, as Gasho's other dialogs; Gasho's colours, and Japanese.
import { motion, useReducedMotion } from "framer-motion";
import { Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DIALOG_OVERLAY } from "@/components/dialog-styles";
import { appleBrowser, shortcutKeys, shortcutOf } from "@/lib/shortcuts";
import { composing, typingIn } from "@/lib/text-input";
import { cn } from "@/lib/utils";

export interface CommandPaletteItem {
  id: string;
  /** The heading it is under. The groups show in the order of their first rows. */
  group: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** The keys of its shortcut, one a chip (lib/shortcuts' shortcutKeys). */
  keys?: string[];
  /** Why it cannot be used now: it shows dimmed, with this under its label. */
  unavailable?: string;
  /** Runs once the palette has closed and the focus has gone back, so that a dialog it opens keeps the focus. */
  run: () => void;
}

const spring = { type: "spring", stiffness: 520, damping: 40, mass: 0.6 } as const;

/** Full-width letters and digits (typed with a Japanese input method left on) match their ASCII ones. */
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

function matching(items: CommandPaletteItem[], query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((i) => {
    const text = fold(`${i.label} ${i.description ?? ""} ${i.group}`);
    return words.every((w) => text.includes(w));
  });
}

export function CommandPalette({ open, onOpenChange, items }: { open: boolean; onOpenChange: (open: boolean) => void; items: CommandPaletteItem[] }) {
  const picked = useRef<CommandPaletteItem>(undefined);
  // Where the focus was when it opened (the chat box, say), which it goes back to. Radix gives it back to the dialog's
  // trigger, and the palette has none: it opens with a key.
  const before = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (open) before.current = document.activeElement;
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          aria-describedby={undefined}
          // ⌘K closes it as it opened it: the screen's shortcuts leave the keys of a dialog to it.
          onKeyDown={(e) => {
            if (shortcutOf(e.nativeEvent, appleBrowser(), typingIn(e.target)) !== "palette") return;
            e.preventDefault();
            onOpenChange(false);
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (before.current instanceof HTMLElement && before.current.isConnected) before.current.focus();
            const item = picked.current;
            picked.current = undefined;
            item?.run();
          }}
          className="fixed top-[calc(var(--safe-top)+3rem)] left-1/2 z-[91] flex max-h-[calc(100dvh-var(--safe-top)-4rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:top-24"
        >
          <Dialog.Title className="sr-only">検索と操作</Dialog.Title>
          <PaletteBody
            items={items}
            onPick={(item) => {
              picked.current = item;
              onOpenChange(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What the palette holds while it is open: drawn afresh each time it opens, with the search box empty. */
function PaletteBody({ items, onPick }: { items: CommandPaletteItem[]; onPick: (item: CommandPaletteItem) => void }) {
  const id = useId();
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => matching(items, query), [items, query]);
  const groups = useMemo(() => {
    const byGroup = new Map<string, CommandPaletteItem[]>();
    for (const item of shown) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
    return [...byGroup];
  }, [shown]);
  // The rows in the order they show (a group's rows together), which ↑↓ go through.
  const rows = useMemo(() => groups.flatMap(([, g]) => g), [groups]);
  const [activeAt, setActive] = useState(0);
  // The items change while the palette is open (a session starts working, or ends): the highlight stays on the list.
  const active = Math.min(activeAt, rows.length - 1);
  const [box, setBox] = useState<{ y: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const byKeyboard = useRef(false);
  const apple = appleBrowser();

  useLayoutEffect(() => {
    const el = rows[active] && rowRefs.current.get(rows[active].id);
    const scroller = scrollRef.current;
    if (!el || !scroller) {
      setBox(null);
      return;
    }
    setBox({ y: el.offsetTop, h: el.offsetHeight });
    if (byKeyboard.current) {
      byKeyboard.current = false;
      if (el.offsetTop < scroller.scrollTop) scroller.scrollTop = el.offsetTop - 4;
      else if (el.offsetTop + el.offsetHeight > scroller.scrollTop + scroller.clientHeight)
        scroller.scrollTop = el.offsetTop + el.offsetHeight - scroller.clientHeight + 4;
    }
  }, [active, rows]);

  const pick = (item: CommandPaletteItem | undefined) => {
    if (item && !item.unavailable) onPick(item);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (composing(e)) return;
    const n = rows.length;
    if (n === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      byKeyboard.current = true;
      setActive((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[active]);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
          }}
          onKeyDown={onKeyDown}
          placeholder="worktree・セッション・操作を検索"
          role="combobox"
          aria-label="worktree・セッション・操作を検索"
          aria-expanded
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={rows[active] ? `${id}-${active}` : undefined}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Dialog.Close
          aria-label="閉じる"
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          esc
        </Dialog.Close>
      </div>

      <div ref={scrollRef} className="max-h-[26rem] min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div id={id} role="listbox" aria-label="worktree・セッション・操作" className="relative p-1.5">
          {box && (
            <motion.div
              aria-hidden
              initial={false}
              animate={{ y: box.y, height: box.h }}
              transition={reduce ? { duration: 0 } : spring}
              className="pointer-events-none absolute inset-x-1.5 top-0 rounded-lg bg-surface-raised"
            />
          )}
          {groups.map(([group, g]) => (
            <div key={group} role="group" aria-label={group} className="pb-1 last:pb-0">
              <div aria-hidden className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {group}
              </div>
              {g.map((item) => {
                const i = rows.indexOf(item);
                const line = item.unavailable ?? item.description;
                return (
                  <div
                    key={item.id}
                    id={`${id}-${i}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(item.id, el);
                      else rowRefs.current.delete(item.id);
                    }}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={item.unavailable ? true : undefined}
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => pick(item)}
                    className={cn("relative flex items-center gap-3 rounded-lg px-2.5 py-2", item.unavailable ? "cursor-default" : "cursor-pointer")}
                  >
                    <span className={cn("flex min-w-0 flex-1 items-center gap-3", item.unavailable && "opacity-50")}>
                      {item.icon && <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&>svg]:size-4">{item.icon}</span>}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{item.label}</span>
                        {line && (
                          <span className="block truncate text-xs text-muted-foreground" title={line}>
                            {line}
                          </span>
                        )}
                      </span>
                    </span>
                    {item.keys && <Keys keys={item.keys} />}
                  </div>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">「{query.trim()}」に合うものがありません</p>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground pointer-coarse:hidden">
        <span className="flex items-center gap-1.5">
          <Keys keys={["↑", "↓"]} />
          移動
        </span>
        <span className="flex items-center gap-1.5">
          <Keys keys={["↵"]} />
          実行
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Keys keys={shortcutKeys("palette", apple)} />
          開く・閉じる
        </span>
      </div>
    </>
  );
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className="grid h-5 min-w-5 place-items-center rounded border border-border bg-background px-1 font-sans text-[11px] leading-none text-muted-foreground">
          {k}
        </kbd>
      ))}
    </span>
  );
}
