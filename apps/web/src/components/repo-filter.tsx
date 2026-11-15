// The repositories the sidebar's worktrees are narrowed to, checked in a menu at the right of their title. The menu
// also opens the dialog that registers repositories with a working server (repos-dialog). While a plugin's categories
// list the sessions instead (docs/plugins.md, P17), they need no narrowing: a button opens that dialog alone.
import { FolderGit2, ListFilter } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useRef } from "react";
import { MENU, MENU_ITEM } from "@/components/dialog-styles";
import { DrawCheckbox } from "@/components/ui/draw-checkbox";
import { SECTION_BUTTON } from "@/components/ui/sidebar";
import type { RepoChoice } from "@/lib/sessions";
import { cn } from "@/lib/utils";

// Checking a repository leaves the menu open, to check another.
const keepOpen = (e: Event) => e.preventDefault();

export function RepoFilter({
  choices,
  picked,
  onPick,
  onRegister,
  machineNames,
}: {
  choices: RepoChoice[];
  /** The repositories the worktrees are narrowed to, of choices; none: all of them. */
  picked: RepoChoice[];
  /** The keys of the repositories now checked, in the order of choices: one picked before that is not among them is left out. */
  onPick: (keys: string[]) => void;
  onRegister: () => void;
  /** Name each repository's working server too (there are several). */
  machineNames: boolean;
}) {
  // Focus goes back to the button when the menu closes, unless the dialog is opening from it.
  const registering = useRef(false);
  const label = picked.length > 0 ? `リポジトリで絞り込む（${picked.map((r) => r.name).join("、")}）` : "リポジトリで絞り込む";
  const isPicked = (key: string) => picked.some((r) => r.key === key);
  const toggle = (key: string, on: boolean) => onPick(choices.flatMap((c) => ((c.key === key ? on : isPicked(c.key)) ? [c.key] : [])));
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) registering.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label} title={label} className={cn(SECTION_BUTTON, picked.length > 0 && "text-neutral-900 dark:text-white")}>
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
