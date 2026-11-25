import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EffortLevel } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { BackgroundToggle, EffortPicker } from "@/components/session-controls";
import { DefaultEffortSection, DefaultModelSection } from "@/views/settings";
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

test("the default model is set for every browser from its combobox, and back to Claude Code's own", async () => {
  const server = (defaultModel?: "opus") => ({ version: "0.15.0", update: { canUpdate: false }, ...(defaultModel ? { defaultModel } : {}) });
  const hub = await connectHub({ server: server() });
  render(<DefaultModelSection />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^既定のモデル/ }));
  const box = screen.getByRole<HTMLSelectElement>("combobox", { name: "既定のモデル" });
  expect(box.value).toBe("default");

  await user.selectOptions(box, "opus");
  expect(hub.sent.at(-1)).toMatchObject({ type: "defaultModel.set", model: "opus" });
  await hub.say({ type: "server", server: server("opus") });
  expect(box.value).toBe("opus");

  await user.selectOptions(box, "default");
  const back = hub.sent.at(-1);
  expect(back?.type === "defaultModel.set" && !("model" in back)).toBe(true);
});
