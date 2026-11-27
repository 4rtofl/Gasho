// The palette opened with ⌘K (components/ui/command-palette): what it finds, and what Enter runs.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { CommandPalette, type CommandPaletteItem } from "@/components/ui/command-palette";

function Palette({ items }: { items: CommandPaletteItem[] }) {
  const [open, setOpen] = useState(true);
  return <CommandPalette open={open} onOpenChange={setOpen} items={items} />;
}

const item = (id: string, group: string, label: string, more: Partial<CommandPaletteItem> = {}): CommandPaletteItem => ({ id, group, label, run: () => {}, ...more });

test("every word typed has to be found in a row, its line under it or its group, full-width letters too", async () => {
  const user = userEvent.setup();
  render(
    <Palette
      items={[
        item("a", "worktree", "feat/325-shortcuts", { description: "Gasho" }),
        item("b", "worktree", "feat/317-markdown", { description: "Gasho" }),
        item("c", "セッション", "ショートカットを足す", { description: "feat/325-shortcuts" }),
      ]}
    />,
  );
  const box = screen.getByRole("combobox");
  await user.type(box, "gasho 325");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["feat/325-shortcutsGasho"]);
  await user.clear(box);
  await user.type(box, "３２５ セッション");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["ショートカットを足すfeat/325-shortcuts"]);
  await user.clear(box);
  await user.type(box, "nothing");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByText("「nothing」に合うものがありません")).toBeTruthy();
});

test("Enter runs the row picked with ↑↓ once the palette has closed, and a row that cannot be used now stays", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  const launch = vi.fn();
  render(
    <Palette
      items={[
        item("remove", "操作", "開いているセッションを削除…", { keys: ["⌥", "⌘", "W"], unavailable: "セッションを開いているときに使えます。", run: remove }),
        item("launch", "操作", "新しいセッション…", { run: launch }),
      ]}
    />,
  );
  const [first] = screen.getAllByRole("option");
  expect(first!.getAttribute("aria-disabled")).toBe("true");
  expect(first!.textContent).toContain("セッションを開いているときに使えます。");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("dialog")).toBeTruthy();

  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => expect(launch).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

test("the key that opens it closes it, without running a row, and the focus goes back to where it was", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  function Opened() {
    const [open, setOpen] = useState(false);
    return (
      <>
        {/* As the screen's shortcut opens it (lib/shortcuts), which the test's browser, not a Mac's, gives with Ctrl+K. */}
        <textarea aria-label="チャット" onKeyDown={(e) => e.ctrlKey && e.key === "k" && setOpen(true)} />
        <CommandPalette open={open} onOpenChange={setOpen} items={[item("launch", "操作", "新しいセッション…", { run })]} />
      </>
    );
  }
  render(<Opened />);
  const chat = screen.getByRole("textbox", { name: "チャット" });
  await user.click(chat);
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.keyboard("{Control>}k{/Control}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(chat));
  expect(run).not.toHaveBeenCalled();
});
