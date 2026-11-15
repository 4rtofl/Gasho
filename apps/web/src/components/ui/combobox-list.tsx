// EasyUI's Combobox (easyui.site/components/combobox): a search box over a list whose one highlight glides between
// the options as you move (keyboard or mouse), with the match underlined as you type. Only its panel is taken, and
// changed for Gasho: it stays open in the page (no trigger, popover or check mark), picking an option runs an action
// (`onPick`) that one option at a time may be busy with, an option has a line on its right (`aside`), and the
// highlight jumps when motion is reduced. Gasho's colours.
import { useReducedMotion, motion } from "framer-motion";
import { LoaderCircle, Search } from "lucide-react";
import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ComboboxListOption {
  value: string;
  label: string;
  description?: string;
  aside?: string;
}

const spring = { type: "spring", stiffness: 520, damping: 40, mass: 0.6 } as const;

const filterOptions = (options: ComboboxListOption[], q: string) =>
  q ? options.filter((o) => [o.label, o.description].some((s) => s?.toLowerCase().includes(q))) : options;

export function ComboboxList({
  options,
  onPick,
  busy,
  searchPlaceholder,
  emptyText,
  "aria-label": ariaLabel,
}: {
  options: ComboboxListOption[];
  onPick: (value: string) => void;
  /**
   * Something under way, during which no option can be picked: the value of the option it is for (which shows a
   * spinner), or of something else.
   */
  busy?: string;
  searchPlaceholder: string;
  /** Shown when nothing matches the search. */
  emptyText: string;
  "aria-label": string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = useMemo(() => filterOptions(options, q), [options, q]);
  const [activeAt, setActive] = useState(0);
  // An option picked goes away (registered), so the list may get shorter under the highlight.
  const active = Math.min(activeAt, items.length - 1);
  const [box, setBox] = useState<{ y: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const byKeyboard = useRef(false);
  const blocked = busy !== undefined;

  // One highlight that glides to the active row (measured, so it survives scrolling).
  useLayoutEffect(() => {
    const el = active >= 0 ? itemRefs.current[active] : undefined;
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
  }, [active, items]);

  const moveTo = (i: number) => {
    byKeyboard.current = true;
    setActive(i);
  };
  const pick = (o: ComboboxListOption | undefined) => {
    if (o && !blocked) onPick(o.value);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = items.length;
    if (n === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTo((active + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      moveTo(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter") {
      // Inside a form, Enter would also submit it.
      e.preventDefault();
      pick(items[active]);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={searchPlaceholder}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded
          aria-controls={id}
          aria-autocomplete="list"
          aria-activedescendant={items[active] ? `${id}-${active}` : undefined}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="h-10 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div ref={scrollRef} className="max-h-64 overflow-y-auto overscroll-contain">
        <div id={id} role="listbox" aria-label={ariaLabel} className="relative p-1">
          {box && items.length > 0 && (
            <motion.div
              aria-hidden
              initial={false}
              animate={{ y: box.y, height: box.h }}
              transition={reduce ? { duration: 0 } : spring}
              className="pointer-events-none absolute inset-x-1 top-0 rounded-lg bg-surface-raised"
            />
          )}

          {items.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-${i}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="option"
              aria-selected={active === i}
              aria-disabled={blocked || undefined}
              onMouseMove={() => active !== i && setActive(i)}
              onClick={() => pick(o)}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2",
                blocked ? "cursor-default" : "cursor-pointer",
                blocked && busy !== o.value && "opacity-50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  <Highlight text={o.label} query={q} />
                </span>
                {o.description && (
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={o.description}>
                    {o.description}
                  </span>
                )}
              </span>
              {busy === o.value ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                o.aside && <span className="shrink-0 text-xs text-muted-foreground">{o.aside}</span>
              )}
            </div>
          ))}

          {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>}
        </div>
      </div>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <span className="underline decoration-muted-foreground underline-offset-[3px]">{text.slice(i, i + query.length)}</span>
      {text.slice(i + query.length)}
    </>
  );
}
