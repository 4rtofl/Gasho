// The repositories the sidebar's worktrees are narrowed to, checked in a menu at the right of their title. When plugins
// offer groupings of the worktrees (docs/plugins.md, P18), the menu also picks one of them, or none. It also opens the
// dialog that registers repositories with a working server (repos-dialog). While a plugin's categories list the
// sessions instead (P17), they need no narrowing: a button opens that dialog alone. Beside the menu, a button opens the
// dialog that clones a repository (clone-repo-dialog).
import { BookOpen, FolderGit2, ListFilter } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";
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
          className={MENU}
          onCloseAutoFocus={(e) => {
            if (registering.current) e.preventDefault();
          }}
        >
          <DropdownMenu.Label className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">リポジトリで絞り込む</DropdownMenu.Label>
          <DropdownMenu.CheckboxItem checked={picked.length === 0} onCheckedChange={() => onPick([])} onSelect={keepOpen} className={MENU_ITEM}>
            <DrawCheckbox checked={picked.length === 0} />
            <span className="min-w-0 flex-1 truncate">すべて</span>
          </DropdownMenu.CheckboxItem>
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
          {groupings.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">分け方</DropdownMenu.Label>
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
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
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
