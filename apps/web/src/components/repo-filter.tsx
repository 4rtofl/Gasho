// The repositories the sidebar's worktrees are narrowed to, checked in a menu at the right of their title. When plugins
// offer groupings of the worktrees (docs/plugins.md, P18), the menu also picks one of them, or none. It also opens the
// dialog that registers repositories with a working server (repos-dialog). Under "表示", it turns on or off the nesting
// of the worktrees under those they were started from (lib/worktree-nesting). While a plugin's categories list the
// sessions instead (P17), they need no narrowing: a button opens that dialog alone. Beside the menu, a button opens the
// dialog that clones a repository (clone-repo-dialog).
//
// The menu is a column as tall as the window allows: the repositories' rows, under "すべて", scroll in a box of about
// eight rows, which shrinks further on a low window; the sections below them (Section) always show whole.
import { BookOpen, FolderGit2, ListFilter } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef, type FocusEvent, type ReactNode } from "react";
import { MENU, MENU_ITEM } from "@/components/dialog-styles";
import { DrawCheckbox } from "@/components/ui/draw-checkbox";
import { SECTION_BUTTON } from "@/components/ui/sidebar";
import type { RepoChoice } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import type { GroupingOption } from "@/lib/worktree-groupings";

// Checking a repository leaves the menu open, to check another.
const keepOpen = (e: Event) => e.preventDefault();

/** The value of "分けない" among the groupings (theirs are `<plugin>/<grouping>`). */
const UNGROUPED = "\u001f";

/** The label of a part of the menu. */
const LABEL = "px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground";

/** A part of the menu under the repositories, after a line: it never scrolls away. */
function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="shrink-0">
      <DropdownMenu.Separator className="my-1 h-px bg-border" />
      {label && <DropdownMenu.Label className={LABEL}>{label}</DropdownMenu.Label>}
      {children}
    </div>
  );
}

/**
 * Brings a row moved to with the keyboard (↑↓, Home, End, typing its name) into its box, at the nearest edge. The
 * pointer resting on a row half hidden at the edge does not scroll the box: Radix focuses that row without scrolling.
 */
function revealFocused(e: FocusEvent<HTMLElement>) {
  if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) e.target.scrollIntoView({ block: "nearest" });
}

/** The mark of a grouping in the menu: round, and filled for the one in use, as DrawCheckbox is when checked. */
function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        checked ? "border-primary bg-primary" : "border-border bg-surface-raised",
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
    </span>
  );
}

export function RepoFilter({
  choices,
  picked,
  onPick,
  onRegister,
  machineNames,
  groupings = [],
  grouping,
  onGroup,
  nested,
  onNest,
}: {
  choices: RepoChoice[];
  /** The repositories the worktrees are narrowed to, of choices; none: all of them. */
  picked: RepoChoice[];
  /** The keys of the repositories now checked, in the order of choices: one picked before that is not among them is left out. */
  onPick: (keys: string[]) => void;
  onRegister: () => void;
  /** Name each repository's working server too (there are several). */
  machineNames: boolean;
  /** The groupings of the worktrees that the plugins offer; none: the menu does not offer "分け方". */
  groupings?: GroupingOption[];
  /** The key of the grouping in use; undefined: "分けない". */
  grouping?: string;
  onGroup?: (key: string | undefined) => void;
  /** Whether the worktrees are nested under those they were started from ("worktree を入れ子にする"). */
  nested: boolean;
  onNest: (on: boolean) => void;
}) {
  // Focus goes back to the button when the menu closes, unless the dialog is opening from it.
  const registering = useRef(false);
  const narrowing = picked.length > 0 ? picked.map((r) => r.name).join("、") : undefined;
  const grouped = groupings.find((g) => g.key === grouping)?.label;
  const states = [narrowing && `絞り込み：${narrowing}`, grouped && `分け方：${grouped}`].filter(Boolean).join("、");
  const label =
    groupings.length === 0 ? (narrowing ? `リポジトリで絞り込む（${narrowing}）` : "リポジトリで絞り込む") : states ? `絞り込みと分け方（${states}）` : "絞り込みと分け方";
  const isPicked = (key: string) => picked.some((r) => r.key === key);
  const toggle = (key: string, on: boolean) => onPick(choices.flatMap((c) => ((c.key === key ? on : isPicked(c.key)) ? [c.key] : [])));
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) registering.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label} title={label} className={cn(SECTION_BUTTON, (picked.length > 0 || grouped) && "text-neutral-900 dark:text-white")}>
          <ListFilter />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={cn(MENU, "flex max-h-(--radix-dropdown-menu-content-available-height) flex-col overflow-y-auto")}
          onCloseAutoFocus={(e) => {
            if (registering.current) e.preventDefault();
          }}
        >
          <DropdownMenu.Label className={cn(LABEL, "shrink-0")}>リポジトリで絞り込む</DropdownMenu.Label>
          <DropdownMenu.CheckboxItem
            checked={picked.length === 0}
            onCheckedChange={() => onPick([])}
            onSelect={keepOpen}
            className={cn(MENU_ITEM, "shrink-0")}
          >
            <DrawCheckbox checked={picked.length === 0} />
            <span className="min-w-0 flex-1 truncate">すべて</span>
          </DropdownMenu.CheckboxItem>
          {choices.length > 0 && (
            // About eight rows (32px each); at least one on a window too low for the rest, when the menu scrolls whole.
            <DropdownMenu.Group
              aria-label="リポジトリ"
              onFocus={revealFocused}
              className="max-h-64 min-h-8 shrink overflow-y-auto overscroll-contain"
            >
              {choices.map((c) => (
                <DropdownMenu.CheckboxItem
                  key={c.key}
                  checked={isPicked(c.key)}
                  onCheckedChange={(on) => toggle(c.key, on)}
                  onSelect={keepOpen}
                  className={MENU_ITEM}
                >
                  <DrawCheckbox checked={isPicked(c.key)} />
                  <span className="min-w-0 flex-1 truncate">
                    {c.name}
                    {machineNames && <span className="text-xs text-muted-foreground"> · {c.machine.name}</span>}
                  </span>
                </DropdownMenu.CheckboxItem>
              ))}
            </DropdownMenu.Group>
          )}
          {groupings.length > 0 && (
            <Section label="分け方">
              <DropdownMenu.RadioGroup value={grouped ? grouping : UNGROUPED} onValueChange={(v) => onGroup?.(v === UNGROUPED ? undefined : v)}>
                <DropdownMenu.RadioItem value={UNGROUPED} className={MENU_ITEM}>
                  <RadioMark checked={!grouped} />
                  <span className="min-w-0 flex-1 truncate">分けない</span>
                </DropdownMenu.RadioItem>
                {groupings.map((g) => (
                  <DropdownMenu.RadioItem key={g.key} value={g.key} className={MENU_ITEM}>
                    <RadioMark checked={g.key === grouping} />
                    <span className="min-w-0 flex-1 truncate">
                      {g.label}
                      {g.ambiguous && <span className="text-xs text-muted-foreground"> · {g.pluginName}</span>}
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </Section>
          )}
          <Section label="表示">
            <DropdownMenu.CheckboxItem checked={nested} onCheckedChange={onNest} onSelect={keepOpen} className={MENU_ITEM}>
              <DrawCheckbox checked={nested} />
              <span className="min-w-0 flex-1 truncate">worktree を入れ子にする</span>
            </DropdownMenu.CheckboxItem>
          </Section>
          <Section>
            <DropdownMenu.Item
              onSelect={() => {
                registering.current = true;
                onRegister();
              }}
              className={cn(MENU_ITEM, "[&>svg]:text-muted-foreground")}
            >
              <FolderGit2 />
              リポジトリを登録・解除…
            </DropdownMenu.Item>
          </Section>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The button that opens the dialog registering repositories, in place of the menu while a plugin's categories show. */
export function RegisterRepos({ onRegister }: { onRegister: () => void }) {
  return (
    <button type="button" onClick={onRegister} aria-label="リポジトリを登録・解除…" title="リポジトリを登録・解除…" className={SECTION_BUTTON}>
      <FolderGit2 />
    </button>
  );
}

/** The button that opens the dialog cloning a repository onto a working server. */
export function CloneRepoButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="リポジトリを clone" title="リポジトリを clone" className={SECTION_BUTTON}>
      <BookOpen />
    </button>
  );
}
