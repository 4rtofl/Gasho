"use client";
// From easyui.site (Sidebar). Changed for Gasho: user-visible strings are in Japanese, an item can have a second line
// (`description`), for a worktree's repository, a mark at its right (`mark`) and its button wrapped (`wrap`, for a
// session's context menu), a section's title can have buttons (`action`, for "＋", `secondaryAction`, and `tools`), the
// items of a section can be put in another order by dragging them (`sort`), a section can hold groups of items under
// headings of their own that fold (`groups`, a plugin's categories of sessions), which can be dragged too
// (`groupSort`), whose items can be dragged from one group into another (`itemMove`), and the width on a computer can
// be changed by dragging the right edge (`ResizeHandle`, lib/widths).

import * as React from "react";
import { AnimatePresence, motion, useDragControls, type PanInfo } from "framer-motion";
import { ChevronRight, GripVertical, PanelLeft } from "lucide-react";
import { useWindowWidth } from "../../lib/media";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, clampSidebarWidth, useSidebarWidth } from "../../lib/widths";
import { groupDrop, itemsByGroup, useSortable, type Sortable } from "../../lib/sortable";
import { cn } from "../../lib/utils";
import { ResizeHandle } from "../resize-handle";

function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void
): [T, (next: T) => void] {
  const [internal, setInternal] = React.useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? (value as T) : internal;

  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });

  const set = React.useCallback(
    (next: T) => {
      if (!controlled) setInternal(next);
      onChangeRef.current?.(next);
    },
    [controlled]
  );

  return [current, set];
}

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.8 } as const;
const COLLAPSED = 56;

export type SidebarChild = { id: string; label: string; badge?: string | number };
export type SidebarItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  children?: SidebarChild[];
  /** Gasho: a smaller line under the label. */
  description?: string;
  /** Gasho: a small mark at the right of the label (a spinner, for a session's work in the background). */
  mark?: React.ReactNode;
  /** Gasho: wraps the item's button, for a session's context menu (the wrapper passes the button's props on). */
  wrap?: (button: React.ReactElement) => React.ReactNode;
};
/** Gasho: a button at the right of a section's title, such as "＋" to add an item. */
export type SidebarAction = { label: string; icon: React.ReactNode; onClick: () => void };
/**
 * Gasho: the items of a section can be put in another order: dragged with a mouse (a click still opens them), dragged
 * by the handle at their right on a touch screen, or moved with Alt+↑/↓. `onReorder` gets the new order.
 */
export type SidebarSort = { onReorder: (ids: string[]) => void };
/**
 * Gasho: items under a heading of their own in a section (a category of sessions). Pressing the heading folds or
 * unfolds them; what shows while folded is up to `items`. In the icon-only sidebar the heading is a divider, or, folded,
 * one item (`icon`) that opens the sidebar and unfolds it.
 */
export type SidebarGroup = {
  id: string;
  title: string;
  /** Dimmer text after the title. */
  description?: string;
  /** Shown on hover over the heading. */
  hint?: string;
  badge?: string | number;
  icon?: React.ReactNode;
  /** A button at the right of the heading ("＋"), only in the full sidebar. */
  action?: SidebarAction;
  folded: boolean;
  onFoldedChange: (folded: boolean) => void;
  items: SidebarItem[];
  sort?: SidebarSort;
};
/**
 * Gasho: an item dropped in another group of its section (`id`: the item; `from`, `to`: the groups), with the items of
 * the group it went into, in their order then.
 */
export type SidebarMove = { id: string; from: string; to: string; ids: string[] };
export type SidebarSection = {
  title?: string;
  items: SidebarItem[];
  action?: SidebarAction;
  /** Gasho: a button before `action`, only in the full sidebar (not in the icon-only one). */
  secondaryAction?: SidebarAction;
  /** Gasho: what goes before `secondaryAction`, such as a menu, also only in the full sidebar. */
  tools?: React.ReactNode;
  sort?: SidebarSort;
  /** Gasho: a line under the title, in the full sidebar (why the list is not what it was). */
  notice?: React.ReactNode;
  /** Gasho: groups after the items, each under a heading; with `groupSort`, they are dragged by their headings. */
  groups?: SidebarGroup[];
  groupSort?: SidebarSort;
  /**
   * Gasho: the groups' items can also be dragged from one group into another (all of them, those of a folded group
   * too), and moved past a heading with Alt+↑/↓. A drop in the same group still goes to that group's `sort`.
   */
  itemMove?: (move: SidebarMove) => void;
};

const SidebarContext = React.createContext({ collapsed: false });
/** Use inside `header` / `footer` to adapt to the icon-only state. */
export const useSidebar = () => React.useContext(SidebarContext);

export interface SidebarProps {
  sections: SidebarSection[];
  activeId: string;
  onActiveChange: (id: string) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  /** Gasho: the mouse came over the list of items, or left it. */
  onPointerInside?: (inside: boolean) => void;
  className?: string;
}

export function Sidebar({
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
  mobileOpen: mobileProp,
  onMobileOpenChange,
  className,
  ...content
}: SidebarProps) {
  const [collapsed, setCollapsed] = useControllableState(collapsedProp, defaultCollapsed, onCollapsedChange);
  const [mobileOpen, setMobileOpen] = useControllableState(mobileProp, false, onMobileOpenChange);
  // Gasho: the drawer is swiped closed from anywhere but what drags an item to another place.
  const drawerDrag = useDragControls();
  // Gasho: the width saved, or the one being dragged to (saved when the drag ends).
  const [savedWidth, setSavedWidth] = useSidebarWidth();
  const [dragWidth, setDragWidth] = React.useState<number | null>(null);
  const windowWidth = useWindowWidth();
  const clampWidth = (w: number) => clampSidebarWidth(w, windowWidth);
  const width = clampWidth(dragWidth ?? savedWidth ?? SIDEBAR_WIDTH_DEFAULT);

  // ⌘B / Ctrl+B
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (window.matchMedia("(min-width: 768px)").matches) setCollapsed(!collapsed);
        else setMobileOpen(!mobileOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, mobileOpen, setCollapsed, setMobileOpen]);

  // drawer: Esc to close + scroll lock
  React.useEffect(() => {
    if (!mobileOpen || window.matchMedia("(min-width: 768px)").matches) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMobileOpen(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen, setMobileOpen]);

  return (
    <>
      {/* Gasho: under the notch of an iPhone held sideways, the sidebar's background (its content stays beside it). */}
      <div aria-hidden className="hidden w-(--safe-left) shrink-0 bg-white md:block dark:bg-neutral-950" />
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? COLLAPSED : width }}
        // While dragged, the edge stays under the pointer.
        transition={dragWidth === null ? spring : { duration: 0 }}
        className={cn(
          "relative hidden h-full shrink-0 overflow-hidden border-r border-neutral-200 bg-white pt-(--safe-top) md:block dark:border-neutral-800 dark:bg-neutral-950",
          className
        )}
      >
        <Panel {...content} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        {!collapsed && (
          <ResizeHandle
            edge="right"
            label="サイドバーの幅"
            width={width}
            min={SIDEBAR_WIDTH_MIN}
            max={clampWidth(SIDEBAR_WIDTH_MAX)}
            clamp={clampWidth}
            onDrag={setDragWidth}
            // The default width is not saved, so that it is followed if it changes.
            onChange={(w) => setSavedWidth(w === SIDEBAR_WIDTH_DEFAULT ? null : w)}
            onReset={() => setSavedWidth(null)}
          />
        )}
      </motion.aside>

      <AnimatePresence>
        {mobileOpen && (
          <div key="drawer" className="fixed inset-0 z-50 md:hidden">
            <motion.div
              aria-hidden
              className="absolute inset-0 bg-neutral-950/40 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="absolute inset-y-0 left-0 w-[17rem] max-w-[85vw] overflow-hidden border-r border-neutral-200 bg-white pt-(--safe-top) pl-(--safe-left) shadow-2xl dark:border-neutral-800 dark:bg-neutral-950"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={spring}
              drag="x"
              dragListener={false}
              dragControls={drawerDrag}
              onPointerDown={(e) => {
                const target = e.target as Element;
                if (target.closest("[data-sort-handle]") || (e.pointerType === "mouse" && target.closest("[data-sort-row]"))) return;
                drawerDrag.start(e);
              }}
              // What framer-motion sets on a drag="x" element that starts its own drags.
              draggable={false}
              style={{ touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 0.5, right: 0 }}
              dragMomentum={false}
              onDragEnd={(_, info: PanInfo) => {
                if (info.offset.x < -80 || info.velocity.x < -400) setMobileOpen(false);
              }}
            >
              <Panel {...content} collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

/** Put anywhere (e.g. your top bar). Only visible below md. */
export function SidebarTrigger({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label="Open navigation"
      className={cn(
        "grid size-9 place-items-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 md:hidden dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white",
        className
      )}
      {...props}
    >
      <PanelLeft className="size-[18px]" />
    </button>
  );
}

/* ───────────────────────── internals ───────────────────────── */

/** Gasho: the look of a button at the right of a section's title (SectionAction, and what `tools` gives). */
export const SECTION_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-neutral-400 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-white dark:focus-visible:ring-neutral-600/60 [&>svg]:size-4";

/** Gasho: the button at the right of a section's title. In the drawer, it closes the drawer too (`onNavigate`). */
function SectionAction({ action, onNavigate }: { action: SidebarAction; onNavigate?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        action.onClick();
        onNavigate?.();
      }}
      aria-label={action.label}
      title={action.label}
      className={SECTION_BUTTON}
    >
      {action.icon}
    </button>
  );
}

/** Gasho: tells the panel while something of its is dragged (each list by its own id), to keep the hover highlight away. */
type OnSorting = (list: string, dragging: boolean) => void;

function useTellSorting(onSorting: OnSorting, dragging: boolean): void {
  const list = React.useId();
  React.useEffect(() => onSorting(list, dragging), [onSorting, list, dragging]);
  React.useEffect(() => () => onSorting(list, false), [onSorting, list]);
}

/**
 * Gasho: the items of a section or a group that can be put in another order (`sort`), drawn by `children` with what
 * makes one draggable. `still`: the group they are in is being dragged, so they do not slide in it.
 */
function SortableItems({
  items,
  sort,
  onSorting,
  still = false,
  children,
}: {
  items: SidebarItem[];
  sort: SidebarSort;
  onSorting: OnSorting;
  still?: boolean;
  children: (item: SidebarItem, sortable: Sortable, still: boolean) => React.ReactNode;
}) {
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const sortable = useSortable({ ids, mode: "list", onCommit: sort.onReorder, label: (id) => byId.get(id)?.label ?? id });
  useTellSorting(onSorting, sortable.dragging);
  return (
    <>
      {sortable.order.map((id) => {
        const item = byId.get(id);
        return item ? children(item, sortable, still) : null;
      })}
      <p className="sr-only" aria-live="polite">
        {sortable.announcement}
      </p>
    </>
  );
}

/** Gasho: the groups of a section that can be put in another order (`groupSort`), each dragged by its heading. */
function SortableGroups({
  groups,
  sort,
  onSorting,
  children,
}: {
  groups: SidebarGroup[];
  sort: SidebarSort;
  onSorting: OnSorting;
  children: (group: SidebarGroup, sortable: Sortable) => React.ReactNode;
}) {
  const ids = React.useMemo(() => groups.map((g) => g.id), [groups]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const sortable = useSortable({ ids, mode: "list", onCommit: sort.onReorder, label: (id) => byId.get(id)?.title ?? id });
  useTellSorting(onSorting, sortable.dragging);
  return (
    <>
      {sortable.order.map((id) => {
        const group = byId.get(id);
        return group ? children(group, sortable) : null;
      })}
      <p className="sr-only" aria-live="polite">
        {sortable.announcement}
      </p>
    </>
  );
}

/** Gasho: the place of a group's heading among the items dragged as one list (MovableGroupItems). */
const HEADING = "\u001eheading\u001e";
const headingOf = (id: string) => (id.startsWith(HEADING) ? id.slice(HEADING.length) : undefined);

/** Gasho: what MovableGroupItems gives to draw the groups with: the items each shows, and its heading's element. */
type MovableItems = { sortable: Sortable; items: (group: string) => SidebarItem[]; heading: (group: string) => (el: HTMLElement | null) => void };

/**
 * Gasho: the items of a section's groups as one list, with the groups' headings fixed in it (`itemMove`): an item
 * dragged past a heading goes into that heading's group.
 */
function MovableGroupItems({
  groups,
  move,
  onSorting,
  children,
}: {
  groups: SidebarGroup[];
  move: (move: SidebarMove) => void;
  onSorting: OnSorting;
  children: (movable: MovableItems) => React.ReactNode;
}) {
  const ids = React.useMemo(() => groups.flatMap((g) => [HEADING + g.id, ...g.items.map((i) => i.id)]), [groups]);
  const byId = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i] as const)));
  const home = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, g.id] as const)));
  const titles = new Map(groups.map((g) => [g.id, g.title]));
  const fixed = (id: string) => headingOf(id) !== undefined;
  const sortable = useSortable({
    ids,
    mode: "list",
    fixed,
    onCommit: (next) => {
      const drop = groupDrop(
        groups.map((g) => ({ id: g.id, items: g.items.map((i) => i.id) })),
        itemsByGroup(next, headingOf, (id) => home.get(id)),
      );
      if (drop?.kind === "move") move(drop);
      else if (drop?.kind === "reorder") groups.find((g) => g.id === drop.group)?.sort?.onReorder(drop.ids);
    },
    label: (id) => byId.get(id)?.label ?? id,
    describe: (id, order) => {
      const at = order.indexOf(id);
      let start = at;
      while (start > 0 && !fixed(order[start - 1]!)) start--;
      let end = at;
      while (end < order.length - 1 && !fixed(order[end + 1]!)) end++;
      const group = start > 0 ? headingOf(order[start - 1]!) : home.get(id);
      const title = (group !== undefined && titles.get(group)) || "";
      return `「${byId.get(id)?.label ?? id}」を「${title}」の ${at - start + 1} 番目に移動しました（全 ${end - start + 1} 件）`;
    },
  });
  useTellSorting(onSorting, sortable.dragging);
  const shown = itemsByGroup(sortable.order, headingOf, (id) => home.get(id));
  return (
    <>
      {children({
        sortable,
        items: (group) => (shown.get(group) ?? []).flatMap((id) => byId.get(id) ?? []),
        heading: (group) => sortable.item(HEADING + group).ref,
      })}
      <p className="sr-only" aria-live="polite">
        {sortable.announcement}
      </p>
    </>
  );
}

type PanelProps = Pick<SidebarProps, "sections" | "activeId" | "onActiveChange" | "header" | "footer" | "onPointerInside"> & {
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
};

function Panel({
  sections,
  activeId,
  onActiveChange,
  header,
  footer,
  onPointerInside,
  collapsed,
  onToggle,
  onNavigate,
}: PanelProps) {
  const uid = React.useId();
  const [hoverBox, setHoverBox] = React.useState<{ y: number; h: number } | null>(null);
  const [hovering, setHovering] = React.useState(false);
  const [tip, setTip] = React.useState<{ label: string; x: number; y: number } | null>(null);
  const [open, setOpen] = React.useState<Set<string>>(
    () =>
      new Set(
        sections
          .flatMap((s) => s.items)
          .filter((i) => i.children?.some((c) => c.id === activeId))
          .map((i) => i.id)
      )
  );

  // Gasho: while an item or a group is dragged to another place, the hover highlight and the tooltip stay away. A
  // group's items are a list of their own inside it, so the lists being dragged are counted.
  const sorting = React.useRef(new Set<string>());
  const onSorting = React.useCallback<OnSorting>((list, dragging) => {
    if (!dragging) {
      sorting.current.delete(list);
      return;
    }
    sorting.current.add(list);
    setHovering(false);
    setTip(null);
  }, []);
  const nav = React.useRef<HTMLElement>(null);

  const enter = (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>, label: string) => {
    if (sorting.current.size > 0) return;
    const el = e.currentTarget;
    // Gasho: measured from the list, not from offsetTop, as a draggable item is positioned itself.
    const list = nav.current;
    const y = list ? el.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop : el.offsetTop;
    setHoverBox({ y, h: el.offsetHeight });
    setHovering(true);
    if (collapsed) {
      const r = el.getBoundingClientRect();
      setTip({ label, x: r.right + 10, y: r.top + r.height / 2 });
    } else setTip(null);
  };

  const renderItem = (item: SidebarItem, sort?: Sortable, still = false) => {
    const hasChildren = !!item.children?.length;
    const isOpen = hasChildren && open.has(item.id) && !collapsed;
    const childActive = !!item.children?.some((c) => c.id === activeId);
    const isActive = !hasChildren && activeId === item.id;
    const tipLabel = item.description ? `${item.label} · ${item.description}` : item.label;

    const onClick = () => {
      if (!hasChildren) {
        onActiveChange(item.id);
        onNavigate?.();
      } else if (collapsed) {
        onToggle?.();
        setOpen((p) => new Set(p).add(item.id));
      } else {
        setOpen((p) => {
          const n = new Set(p);
          if (n.has(item.id)) n.delete(item.id);
          else n.add(item.id);
          return n;
        });
      }
    };

    const button = (
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={(e) => enter(e, tipLabel)}
        onFocus={(e) => enter(e, tipLabel)}
        aria-label={collapsed ? tipLabel : undefined}
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "relative flex w-full items-center gap-3 rounded-lg px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:focus-visible:ring-neutral-600/60",
          item.description ? "min-h-9 py-1" : "h-9",
          isActive || childActive
            ? "text-neutral-900 dark:text-white"
            : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
        )}
      >
        {isActive && (
          <motion.span
            layoutId={`${uid}-active`}
            transition={spring}
            className="absolute inset-0 rounded-lg bg-neutral-200/70 dark:bg-neutral-800"
          />
        )}
        <span className="relative grid size-5 shrink-0 place-items-center [&>svg]:size-[18px]">{item.icon}</span>
        <motion.span
          initial={false}
          animate={{ opacity: collapsed ? 0 : 1 }}
          transition={{ duration: 0.15 }}
          className="relative min-w-0 flex-1 whitespace-nowrap text-left"
        >
          <span className="block truncate">{item.label}</span>
          {item.description && (
            <span className="block truncate text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">{item.description}</span>
          )}
        </motion.span>
        {!collapsed && item.mark && <span className="relative grid shrink-0 place-items-center">{item.mark}</span>}
        {!collapsed && item.badge !== undefined && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="relative rounded-md bg-neutral-200/70 px-1.5 text-[11px] tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {item.badge}
          </motion.span>
        )}
        {!collapsed && hasChildren && (
          <ChevronRight
            className={cn(
              "relative size-3.5 shrink-0 text-neutral-400 transition-transform duration-200",
              isOpen && "rotate-90"
            )}
          />
        )}
      </button>
    );

    const children = (
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-[19px] mt-0.5 space-y-0.5 border-l border-neutral-200 py-0.5 pl-3 dark:border-neutral-800">
              {item.children!.map((c) => {
                const active = c.id === activeId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      onActiveChange(c.id);
                      onNavigate?.();
                    }}
                    onMouseEnter={() => {
                      setHovering(false);
                      setTip(null);
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:focus-visible:ring-neutral-600/60",
                      active
                        ? "text-neutral-900 dark:text-white"
                        : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId={`${uid}-dot`}
                        transition={spring}
                        className="absolute -left-[15.5px] top-[13px] size-1.5 rounded-full bg-neutral-900 dark:bg-white"
                      />
                    )}
                    <span className="flex-1 truncate text-left">{c.label}</span>
                    {c.badge !== undefined && (
                      <span className="text-[11px] tabular-nums text-neutral-400">{c.badge}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );

    // Gasho: a session's context menu opens from its button.
    const shown = item.wrap ? item.wrap(button) : button;

    if (!sort) {
      return (
        <div key={item.id}>
          {shown}
          {children}
        </div>
      );
    }

    // Gasho: an item that can be put in another order. With a mouse, the item itself is dragged (a click still opens
    // it); on a touch screen, the handle at its right is (touching the item still scrolls the list, and a long press
    // still opens its menu). Alt+↑/↓ moves it too.
    const p = sort.item(item.id);
    const lifted = sort.dragging && sort.active === item.id;
    return (
      <motion.div
        key={item.id}
        ref={p.ref}
        layout={still ? false : p.layout}
        transition={p.transition}
        style={p.style}
        data-sort-row
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") sort.start(item.id, e);
        }}
        onKeyDown={(e) => {
          if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          sort.moveTo(item.id, sort.order.indexOf(item.id) + (e.key === "ArrowUp" ? -1 : 1));
        }}
        className={cn(
          "relative rounded-lg",
          lifted && "bg-white shadow-lg ring-1 ring-black/[0.06] dark:bg-neutral-900 dark:ring-white/10"
        )}
      >
        <div className="flex items-center">
          <div className="min-w-0 flex-1">{shown}</div>
          {!collapsed && (
            <span
              data-sort-handle
              aria-hidden
              onPointerDown={(e) => sort.start(item.id, e)}
              className="hidden h-9 w-7 shrink-0 cursor-grab touch-none select-none place-items-center text-neutral-400 [-webkit-touch-callout:none] pointer-coarse:grid dark:text-neutral-500"
            >
              <GripVertical className="size-4" />
            </span>
          )}
        </div>
        {children}
      </motion.div>
    );
  };

  // Gasho: a group of items under its heading. Pressing the heading folds it; with `sort` (the section's `groupSort`),
  // the heading also drags the whole group: itself with a mouse, its handle on a touch screen, Alt+↑/↓ on the keyboard.
  // With `movable` (the section's `itemMove`), its items are those of one list of all the groups' items.
  const renderGroup = (group: SidebarGroup, sort?: Sortable, movable?: MovableItems) => {
    const tipLabel = [group.title, group.description, group.badge].filter((x) => x !== undefined && x !== "").join(" · ");
    // While the group is lifted or settles into its place, its items keep still in it.
    const still = Boolean(sort && sort.active === group.id);
    const lifted = Boolean(sort?.dragging && sort.active === group.id);
    const moveByKey = (e: React.KeyboardEvent) => {
      if (!sort || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      sort.moveTo(group.id, sort.order.indexOf(group.id) + (e.key === "ArrowUp" ? -1 : 1));
    };

    let heading: React.ReactNode;
    if (!collapsed) {
      heading = (
        <div
          data-sort-row={sort ? "" : undefined}
          onPointerDown={(e) => {
            if (sort && e.pointerType === "mouse" && !(e.target as Element).closest("[data-group-action]")) sort.start(group.id, e);
          }}
          className="flex items-center gap-0.5 pt-2"
        >
          <button
            type="button"
            onClick={() => group.onFoldedChange(!group.folded)}
            onKeyDown={moveByKey}
            onMouseEnter={(e) => enter(e, tipLabel)}
            onFocus={(e) => enter(e, tipLabel)}
            aria-expanded={!group.folded}
            title={group.hint}
            className="relative flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md pl-1.5 pr-1.5 text-left text-xs text-neutral-500 outline-none transition-colors hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:text-neutral-400 dark:hover:text-white dark:focus-visible:ring-neutral-600/60"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-200", !group.folded && "rotate-90")} />
            <span className="min-w-0 truncate font-medium">{group.title}</span>
            {group.description && <span className="min-w-0 shrink-[2] truncate text-neutral-400 dark:text-neutral-500">{group.description}</span>}
            {group.badge !== undefined && (
              <span className="ml-auto shrink-0 rounded-md bg-neutral-200/70 px-1.5 text-[11px] tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {group.badge}
              </span>
            )}
          </button>
          {group.action && (
            <span data-group-action className="contents">
              <SectionAction action={group.action} />
            </span>
          )}
          {sort && (
            <span
              data-sort-handle
              aria-hidden
              onPointerDown={(e) => sort.start(group.id, e)}
              className="hidden h-7 w-7 shrink-0 cursor-grab touch-none select-none place-items-center text-neutral-400 [-webkit-touch-callout:none] pointer-coarse:grid dark:text-neutral-500"
            >
              <GripVertical className="size-4" />
            </span>
          )}
        </div>
      );
    } else if (group.folded) {
      // Icon only, folded: one item for the group, which opens the sidebar with the group unfolded.
      heading = (
        <button
          type="button"
          onClick={() => {
            group.onFoldedChange(false);
            onToggle?.();
          }}
          onMouseEnter={(e) => enter(e, tipLabel)}
          onFocus={(e) => enter(e, tipLabel)}
          aria-label={tipLabel}
          aria-expanded={false}
          className="relative flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-neutral-500 outline-none transition-colors hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:text-neutral-400 dark:hover:text-white dark:focus-visible:ring-neutral-600/60"
        >
          <span className="relative grid size-5 shrink-0 place-items-center [&>svg]:size-[18px]">{group.icon}</span>
        </button>
      );
    } else {
      heading = <div className="mx-2.5 my-2 h-px bg-neutral-200 dark:bg-neutral-800" />;
    }

    if (movable) heading = <div ref={movable.heading(group.id)}>{heading}</div>;
    const items = movable ? (
      movable.items(group.id).map((item) => renderItem(item, movable.sortable, still))
    ) : group.sort && group.items.length > 1 ? (
        <SortableItems items={group.items} sort={group.sort} onSorting={onSorting} still={still}>
          {renderItem}
        </SortableItems>
      ) : (
        group.items.map((item) => renderItem(item))
      );
    if (!sort) {
      return (
        <div key={group.id} className="space-y-0.5">
          {heading}
          {items}
        </div>
      );
    }
    const p = sort.item(group.id);
    return (
      <motion.div
        key={group.id}
        ref={p.ref}
        layout={p.layout}
        transition={p.transition}
        style={p.style}
        className={cn(
          "relative space-y-0.5 rounded-lg",
          lifted && "bg-white shadow-lg ring-1 ring-black/[0.06] dark:bg-neutral-900 dark:ring-white/10"
        )}
      >
        {heading}
        {items}
      </motion.div>
    );
  };

  const renderGroups = (section: SidebarSection, movable?: MovableItems) =>
    section.groupSort ? (
      <SortableGroups groups={section.groups ?? []} sort={section.groupSort} onSorting={onSorting}>
        {(group, sort) => renderGroup(group, sort, movable)}
      </SortableGroups>
    ) : (
      (section.groups ?? []).map((group) => renderGroup(group, undefined, movable))
    );

  return (
    <SidebarContext.Provider value={{ collapsed }}>
      <div className="flex h-full flex-col">
        {header && (
          // Gasho: px-2 as the list's, for a header that is a row of its own (the logo, lined up with the items' icons).
          <div
            className={cn(
              "flex h-14 shrink-0 items-center overflow-hidden px-2 transition-all",
              collapsed && "[&>div>*:not(:first-child)]:hidden [&>div]:gap-0 [&>*:not(:first-child)]:hidden"
            )}
          >
            {header}
          </div>
        )}

        {/* Gasho: layoutScroll, for the items that slide to new places inside it, also while it scrolls. */}
        <motion.nav
          ref={nav}
          layoutScroll
          aria-label="Main"
          onMouseEnter={() => onPointerInside?.(true)}
          onMouseLeave={() => {
            setHovering(false);
            setTip(null);
            onPointerInside?.(false);
          }}
          className="relative flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {hoverBox && (
            <motion.span
              aria-hidden
              initial={false}
              animate={{ y: hoverBox.y, height: hoverBox.h, opacity: hovering ? 1 : 0 }}
              transition={{ y: spring, height: spring, opacity: { duration: 0.15 } }}
              className="pointer-events-none absolute inset-x-2 top-0 rounded-lg bg-neutral-100 dark:bg-neutral-900"
            />
          )}

          {sections.map((section, i) => (
            <div key={i} className="space-y-0.5">
              {section.title &&
                (collapsed ? (
                  <div className="mx-2.5 my-2 h-px bg-neutral-200 dark:bg-neutral-800" />
                ) : (
                  <div className="flex items-center gap-1 pb-1 pl-2.5 pr-1 pt-4">
                    <p className="min-w-0 flex-1 truncate text-xs text-neutral-400 dark:text-neutral-500">{section.title}</p>
                    {section.tools}
                    {/* Changes the list in place: the drawer stays open to show it. */}
                    {section.secondaryAction && <SectionAction action={section.secondaryAction} />}
                    {section.action && <SectionAction action={section.action} onNavigate={onNavigate} />}
                  </div>
                ))}
              {!collapsed && section.notice && <p className="px-2.5 pb-1 text-[11px] leading-4 text-amber-500 dark:text-amber-400">{section.notice}</p>}
              {/* Icon only: the action takes a row of its own under the divider, named by the tooltip. */}
              {collapsed && section.action && (
                <button
                  type="button"
                  onClick={section.action.onClick}
                  onMouseEnter={(e) => enter(e, section.action!.label)}
                  onFocus={(e) => enter(e, section.action!.label)}
                  aria-label={section.action.label}
                  className="relative flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-neutral-500 outline-none transition-colors hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:text-neutral-400 dark:hover:text-white dark:focus-visible:ring-neutral-600/60"
                >
                  <span className="relative grid size-5 shrink-0 place-items-center [&>svg]:size-[18px]">{section.action.icon}</span>
                </button>
              )}
              {section.sort ? (
                <SortableItems items={section.items} sort={section.sort} onSorting={onSorting}>
                  {renderItem}
                </SortableItems>
              ) : (
                section.items.map((item) => renderItem(item))
              )}
              {section.groups &&
                (section.itemMove ? (
                  <MovableGroupItems groups={section.groups} move={section.itemMove} onSorting={onSorting}>
                    {(movable) => renderGroups(section, movable)}
                  </MovableGroupItems>
                ) : (
                  renderGroups(section)
                ))}
            </div>
          ))}
        </motion.nav>

        {(footer || onToggle) && (
          <div className="shrink-0 space-y-1 border-t border-neutral-200 p-2 dark:border-neutral-800">
            {footer}
            {onToggle && (
              <button
                type="button"
                onClick={onToggle}
                onMouseEnter={(e) => {
                  if (!collapsed) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  setTip({ label: "開く", x: r.right + 10, y: r.top + r.height / 2 });
                }}
                onMouseLeave={() => setTip(null)}
                aria-label={collapsed ? "サイドバーを開く" : "サイドバーを畳む"}
                className="flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-sm text-neutral-500 outline-none transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-neutral-400/50 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white dark:focus-visible:ring-neutral-600/60"
              >
                <span className="grid size-5 shrink-0 place-items-center">
                  <PanelLeft className="size-[18px]" />
                </span>
                <motion.span
                  initial={false}
                  animate={{ opacity: collapsed ? 0 : 1 }}
                  transition={{ duration: 0.15 }}
                  className="flex-1 whitespace-nowrap text-left"
                >
                  畳む
                </motion.span>
                {!collapsed && (
                  <kbd className="rounded border border-neutral-200 px-1 font-sans text-[10px] text-neutral-400 dark:border-neutral-800">
                    ⌘B
                  </kbd>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {collapsed && tip && (
          <div
            key="tip"
            role="tooltip"
            className="pointer-events-none fixed z-[60] -translate-y-1/2"
            style={{ left: tip.x, top: tip.y }}
          >
            <motion.div
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-white dark:text-neutral-900"
            >
              {tip.label}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </SidebarContext.Provider>
  );
}
