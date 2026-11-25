import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EffortLevel } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { EffortPicker, UltracodeToggle } from "@/components/session-controls";
import { DefaultEffortSection } from "@/views/settings";
import { connectHub } from "./hub";

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

test("the default effort level is set for every browser from the gauge, by its keys, and back to Claude Code's own", async () => {
  const server = (defaultEffort?: EffortLevel) => ({ version: "0.15.0", update: { canUpdate: false }, ...(defaultEffort ? { defaultEffort } : {}) });
  const hub = await connectHub({ server: server() });
  render(<DefaultEffortSection />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^既定の Effort/ }));
  expect(screen.getByRole("radio", { name: "Claude Code の既定" }).getAttribute("aria-checked")).toBe("true");

  await user.click(screen.getByRole("radio", { name: "High" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "defaultEffort.set", effort: "high" });
  await hub.say({ type: "server", server: server("high") });
  expect(screen.getByRole("radio", { name: "High" }).getAttribute("aria-checked")).toBe("true");

  await user.keyboard("{ArrowRight}");
  expect(hub.sent.at(-1)).toMatchObject({ type: "defaultEffort.set", effort: "xhigh" });

  await user.click(screen.getByRole("radio", { name: "Claude Code の既定" }));
  const back = hub.sent.at(-1);
  expect(back?.type === "defaultEffort.set" && !("effort" in back)).toBe(true);
});
