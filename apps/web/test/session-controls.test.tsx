import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { BackgroundToggle, EffortPicker } from "@/components/session-controls";

test("the effort picked is told, and the button says it is switched when sending until the session uses it", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<EffortPicker value="medium" current="medium" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Effort：Medium" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Effort：Medium" }));
  expect(screen.getByRole("menu", { name: "Effort" })).toBeTruthy();
  // The level the session uses now is marked in the menu.
  expect(screen.getByRole("menuitemradio", { name: /Medium.*いま/ })).toBeTruthy();
  await user.click(screen.getByRole("menuitemradio", { name: /^High/ }));
  expect(onChange).toHaveBeenCalledWith("high");

  rerender(<EffortPicker value="high" current="medium" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Effort：High（送るときに切り替えます）" })).toBeTruthy();
});

test("a touch opens the effort menu on the tap, not when the finger lands (a swipe of the toolbar only scrolls it)", async () => {
  const user = userEvent.setup();
  render(<EffortPicker value="low" current="low" onChange={() => {}} />);
  const button = screen.getByRole("button", { name: "Effort：Low" });

  await user.pointer({ keys: "[TouchA>]", target: button });
  expect(screen.queryByRole("menu")).toBeNull();
  await user.pointer({ keys: "[/TouchA]", target: button });
  expect(screen.getByRole("menu", { name: "Effort" })).toBeTruthy();
});

test("ultracode is turned over in the effort menu, which stays open, and the button says it is on and switched when sending", async () => {
  const user = userEvent.setup();
  const onUltra = vi.fn();
  const { rerender } = render(
    <EffortPicker value="high" current="high" onChange={() => {}} ultracode={{ value: false, current: false, onChange: onUltra }} />,
  );
  await user.click(screen.getByRole("button", { name: "Effort：High" }));
  const item = screen.getByRole("menuitemcheckbox", { name: /Ultracode/ });
  expect(item.getAttribute("aria-checked")).toBe("false");
  await user.click(item);
  expect(onUltra).toHaveBeenCalledWith(true);
  // Still open, to pick the effort level after it.
  expect(screen.getByRole("menu", { name: "Effort" })).toBeTruthy();

  rerender(<EffortPicker value="high" current="high" onChange={() => {}} ultracode={{ value: true, current: false, onChange: onUltra }} />);
  expect(screen.getByRole("menuitemcheckbox", { name: /Ultracode.*送るときに切り替えます/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Effort：High・Ultracode オン（送るときに切り替えます）" })).toBeTruthy();
});

test("without ultracode, the effort menu has no ultracode item", async () => {
  const user = userEvent.setup();
  render(<EffortPicker value="low" current="low" onChange={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Effort：Low" }));
  expect(screen.queryByRole("menuitemcheckbox")).toBeNull();
});

test("the background button is there only while something runs, says how many, and shows or hides the list", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const { rerender } = render(<BackgroundToggle count={0} open onToggle={onToggle} />);
  expect(screen.queryByRole("button")).toBeNull();

  rerender(<BackgroundToggle count={3} open onToggle={onToggle} />);
  const button = screen.getByRole("button", { name: "バックグラウンドで実行中（3 件）" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  await user.click(button);
  expect(onToggle).toHaveBeenCalledOnce();
  rerender(<BackgroundToggle count={3} open={false} onToggle={onToggle} />);
  expect(button.getAttribute("aria-pressed")).toBe("false");
});
