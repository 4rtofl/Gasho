import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { EffortPicker, UltracodeToggle } from "@/components/session-controls";

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

test("ultracode turns over, and says it is switched when sending until the session uses it", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<UltracodeToggle value={false} current={false} onChange={onChange} />);
  const button = screen.getByRole("button", { name: "Ultracode" });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.title).not.toContain("送るときに切り替えます");

  await user.click(button);
  expect(onChange).toHaveBeenCalledWith(true);
  rerender(<UltracodeToggle value={true} current={false} onChange={onChange} />);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.title).toContain("送るときに切り替えます");
});
