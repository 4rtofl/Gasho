// Dragging the items of a list into another order, and moving them with the keyboard (useSortable). The pure parts
// (where an item goes) are in sortable.test.ts.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useSortable } from "@/lib/sortable";

const ROW = 40;

/**
 * Lays the rows out as a browser would, one under another by their place in the list (happy-dom lays nothing out);
 * without the transform, as the drag reads them.
 */
function placeRow(el: HTMLElement | null): void {
  if (!el || Object.hasOwn(el, "offsetTop")) return;
  const top = () => [...(el.parentElement?.children ?? [])].indexOf(el) * ROW;
  Object.defineProperties(el, {
    offsetTop: { get: top },
    offsetLeft: { value: 0 },
    offsetWidth: { value: 200 },
    offsetHeight: { value: ROW },
  });
  el.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top(), width: 200, height: ROW });
}

function List({ ids, onCommit, onClick = () => {}, fixed }: { ids: string[]; onCommit: (ids: string[]) => void; onClick?: (id: string) => void; fixed?: (id: string) => boolean }) {
  const s = useSortable({ ids, mode: "list", onCommit, label: (id) => id.toUpperCase(), fixed });
  return (
    <>
      <ul>
        {s.order.map((id) => (
          <li
            key={id}
            ref={(el) => {
              s.item(id).ref(el);
              placeRow(el);
            }}
            onPointerDown={(e) => s.start(id, e)}
            onClick={() => onClick(id)}
          >
            <button type="button" onKeyDown={(e) => e.key === "ArrowDown" && s.moveTo(id, s.order.indexOf(id) + 1)}>
              {id}
            </button>
          </li>
        ))}
      </ul>
      <p role="status">{s.announcement}</p>
      {s.dragging && <p>ドラッグ中</p>}
    </>
  );
}

const shown = () => screen.getAllByRole("listitem").map((li) => li.textContent);
const press = (id: string, y: number, extra: Partial<PointerEventInit> = {}) =>
  fireEvent.pointerDown(screen.getByText(id).closest("li")!, { pointerId: 1, isPrimary: true, button: 0, clientX: 10, clientY: y, ...extra });
const moveTo = (y: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: y });

test("an item dragged past the middle of the others goes there, and the order is told once, when it is dropped", async () => {
  const onCommit = vi.fn();
  const onClick = vi.fn();
  render(<List ids={["a", "b", "c"]} onCommit={onCommit} onClick={onClick} />);

  press("a", 20);
  moveTo(110);
  await waitFor(() => expect(shown()).toEqual(["b", "c", "a"]));
  expect(screen.getByText("ドラッグ中")).toBeTruthy();
  expect(onCommit).not.toHaveBeenCalled();

  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(["b", "c", "a"]);
  expect(screen.getByRole("status").textContent).toBe("「A」を 3 番目に移動しました（全 3 件）");
  // The click that the drop makes over the item is not a click on it.
  fireEvent.click(screen.getByText("a").closest("li")!);
  expect(onClick).not.toHaveBeenCalled();
});

test("Esc while dragging puts the order back and tells nothing", async () => {
  const onCommit = vi.fn();
  const onClick = vi.fn();
  render(<List ids={["a", "b", "c"]} onCommit={onCommit} onClick={onClick} />);
  press("c", 100);
  moveTo(10);
  await waitFor(() => expect(shown()).toEqual(["c", "a", "b"]));

  const esc = fireEvent.keyDown(document.body, { key: "Escape" });
  expect(esc).toBe(false); // kept from what else Esc would close
  expect(shown()).toEqual(["a", "b", "c"]);
  fireEvent.pointerUp(window, { pointerId: 1 });
  fireEvent.click(screen.getByText("c").closest("li")!);
  expect(onCommit).not.toHaveBeenCalled();
  expect(onClick).not.toHaveBeenCalled();
});

test("a press that moves only a little is a click, and only the main button and the first finger drag", async () => {
  const onCommit = vi.fn();
  const onClick = vi.fn();
  render(<List ids={["a", "b", "c"]} onCommit={onCommit} onClick={onClick} />);

  press("a", 20);
  moveTo(22);
  fireEvent.pointerUp(window, { pointerId: 1 });
  fireEvent.click(screen.getByText("a").closest("li")!);
  expect(onClick).toHaveBeenCalledWith("a");

  for (const extra of [{ button: 2 }, { isPrimary: false }]) {
    press("a", 20, extra);
    moveTo(110);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(shown()).toEqual(["a", "b", "c"]);
    fireEvent.pointerUp(window, { pointerId: 1 });
  }
  expect(onCommit).not.toHaveBeenCalled();
});

test("an item moved with the keyboard stays below the fixed items, and its new place is read out", () => {
  const onCommit = vi.fn();
  const { rerender } = render(<List ids={["head", "a", "b"]} onCommit={onCommit} fixed={(id) => id === "head"} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "a" }), { key: "ArrowDown" });
  expect(onCommit).toHaveBeenLastCalledWith(["head", "b", "a"]);
  rerender(<List ids={["head", "b", "a"]} onCommit={onCommit} fixed={(id) => id === "head"} />);
  expect(screen.getByRole("status").textContent).toBe("「A」を 3 番目に移動しました（全 3 件）");

  // Past the end, nothing moves; a fixed item does not move.
  fireEvent.keyDown(screen.getByRole("button", { name: "a" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("button", { name: "head" }), { key: "ArrowDown" });
  expect(onCommit).toHaveBeenCalledTimes(1);
  // A fixed item is not dragged.
  press("head", 20);
  moveTo(110);
  fireEvent.pointerUp(window, { pointerId: 1 });
  expect(onCommit).toHaveBeenCalledTimes(1);
});
