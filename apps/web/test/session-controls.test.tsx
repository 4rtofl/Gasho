import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EffortLevel } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { BackgroundToggle, EffortPicker, EFFORTS } from "@/components/session-controls";
import { setSettingsSectionOpen } from "@/lib/settings-sections";
import { SessionView } from "@/views/session";
import { DefaultEffortSection, DefaultModelSection } from "@/views/settings";
import { connectHub, machine, session } from "./hub";

test("the effort picked is told, and the button says it is switched when sending until the session uses it", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<EffortPicker options={EFFORTS} value="medium" current="medium" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Effort：Medium" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Effort：Medium" }));
  expect(screen.getByRole("menu", { name: "Effort" })).toBeTruthy();
  // The level the session uses now is marked in the menu.
  expect(screen.getByRole("menuitemradio", { name: /Medium.*いま/ })).toBeTruthy();
  await user.click(screen.getByRole("menuitemradio", { name: /^High/ }));
  expect(onChange).toHaveBeenCalledWith("high");

  rerender(<EffortPicker options={EFFORTS} value="high" current="medium" onChange={onChange} />);
  expect(screen.getByRole("button", { name: "Effort：High（送るときに切り替えます）" })).toBeTruthy();
});

test("a touch opens the effort menu on the tap, not when the finger lands (a swipe of the toolbar only scrolls it)", async () => {
  const user = userEvent.setup();
  render(<EffortPicker options={EFFORTS} value="low" current="low" onChange={() => {}} />);
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
    <EffortPicker options={EFFORTS} value="high" current="high" onChange={() => {}} ultracode={{ value: false, current: false, onChange: onUltra }} />,
  );
  await user.click(screen.getByRole("button", { name: "Effort：High" }));
  const item = screen.getByRole("menuitemcheckbox", { name: /Ultracode/ });
  expect(item.getAttribute("aria-checked")).toBe("false");
  await user.click(item);
  expect(onUltra).toHaveBeenCalledWith(true);
  // Still open, to pick the effort level after it.
  expect(screen.getByRole("menu", { name: "Effort" })).toBeTruthy();

  rerender(<EffortPicker options={EFFORTS} value="high" current="high" onChange={() => {}} ultracode={{ value: true, current: false, onChange: onUltra }} />);
  expect(screen.getByRole("menuitemcheckbox", { name: /Ultracode.*送るときに切り替えます/ }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Effort：High・Ultracode オン（送るときに切り替えます）" })).toBeTruthy();
});

test("without ultracode, the effort menu has no ultracode item", async () => {
  const user = userEvent.setup();
  render(<EffortPicker options={EFFORTS} value="low" current="low" onChange={() => {}} />);
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
  setSettingsSectionOpen("default-model", false);
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

test("the shared default explains Fable's fallback when any working server is on Pro", async () => {
  const pro = machine("pro", [], { claudeSubscriptionType: "pro" });
  const hub = await connectHub({
    machines: [pro],
    server: { version: "0.15.0", update: { canUpdate: false }, defaultModel: "fable" },
  });
  setSettingsSectionOpen("default-model", true);
  render(<DefaultModelSection />);
  const user = userEvent.setup();
  const note = "Pro プランの working server では Fable を使えません。既定のモデルが Fable でも、Claude Code の既定のモデルで起動します。";
  expect(screen.getByText(note)).toBeTruthy();
  expect(screen.getByText("Claude Code の既定", { exact: true })).toBeTruthy();
  expect(screen.getByRole<HTMLOptionElement>("option", { name: "Fable（Pro プランでは使えません）" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("");
  await user.selectOptions(screen.getByRole("combobox"), "default");
  expect(hub.sent.at(-1)).toMatchObject({ type: "defaultModel.set" });

  await hub.say({ type: "machine", machine: machine("unknown") });
  expect(screen.getByText(note)).toBeTruthy();
  expect(screen.getByRole<HTMLOptionElement>("option", { name: /^Fable/ }).disabled).toBe(false);
  expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("fable");

  await hub.say({ type: "machine", machine: { ...pro, claudeSubscriptionType: "max" } });
  expect(screen.queryByText(note)).toBeNull();
});

test("the session picker hides Fable on Pro with or without a catalog and ignores a pending Fable pick", async () => {
  const m = machine("picker", [session("s", { model: "Sonnet 5.5" })], { features: ["model"] });
  const hub = await connectHub({ machines: [m] });
  render(<SessionView machine={m.id} sessionId="s" onSessionAction={() => {}} onAskTrust={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^モデル：Sonnet/ }));
  await user.click(screen.getByRole("option", { name: /^Fable/ }));
  expect(screen.getByRole("button", { name: /^モデル：Fable/ })).toBeTruthy();

  const pro = { ...m, claudeSubscriptionType: "pro" };
  await hub.say({ type: "machine", machine: pro });
  await user.click(screen.getByRole("button", { name: /^モデル：Sonnet/ }));
  expect(screen.getByRole("listbox", { name: "モデル" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /^Fable/ })).toBeNull();

  await hub.say({ type: "machine", machine: { ...pro, models: [{ id: "sonnet", name: "Sonnet 5.5" }, { id: "fable", name: "Fable 5.2" }] } });
  expect(screen.queryByRole("option", { name: /^Fable/ })).toBeNull();
  await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "続けて");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() => expect(hub.commands().at(-1)).toMatchObject({ type: "session.input", text: "続けて" }));
  expect(hub.commands().at(-1)).not.toHaveProperty("model");
  await hub.answer({ ok: true });
});

test("a session already using Fable on Pro still shows its current model", async () => {
  const m = machine("current", [session("s", { model: "Fable 5.2" })], { features: ["model"], claudeSubscriptionType: "pro" });
  await connectHub({ machines: [m] });
  render(<SessionView machine={m.id} sessionId="s" onSessionAction={() => {}} onAskTrust={() => {}} />);
  await userEvent.setup().click(screen.getByRole("button", { name: /^モデル：Fable 5.2/ }));
  expect(screen.getByRole("option", { name: /^Fable 5.2.*いま/ })).toBeTruthy();
});

test("external models use their own Effort options and a rejected switch restores the draft", async () => {
  const model = {
    current: "standard",
    options: [
      { id: "standard", name: "Standard", efforts: [{ id: "regular", name: "Regular" }] },
      { id: "pro", name: "Pro Model", efforts: [{ id: "deep", name: "Deep" }], defaultEffort: "deep" },
    ],
  };
  const s = session("s", { agent: "codex", agentConfig: { model, effort: { current: "regular", options: model.options[0]!.efforts } } });
  const m = machine("external-models", [s], { agents: { codex: { status: "available", operations: ["model", "effort"] } } });
  const hub = await connectHub({ machines: [m] });
  render(<SessionView machine={m.id} sessionId="s" onSessionAction={() => {}} onAskTrust={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^モデル：Standard/ }));
  await user.click(screen.getByRole("option", { name: "Pro Model" }));
  await user.click(screen.getByRole("button", { name: /^Effort：Deep/ }));
  expect(screen.queryByRole("menuitemradio", { name: /Regular/ })).toBeNull();
  expect(screen.queryByRole("menuitemcheckbox", { name: /Ultracode/ })).toBeNull();
  await user.click(screen.getByRole("menuitemradio", { name: /Deep/ }));
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "メッセージ" });
  await user.type(box, "続けて");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() => expect(hub.commands().at(-1)).toMatchObject({
    type: "session.input", text: "続けて", screen: true, agentSelection: { model: "pro", effort: "deep" },
  }));
  await hub.answer({ ok: false, error: "このモデルは現在使えません。" });
  expect(await screen.findByText("このモデルは現在使えません。")).toBeTruthy();
  expect(box.value).toBe("続けて");

  const previous = hub.commands().at(-1);
  await user.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() => expect(hub.commands().at(-1)).not.toBe(previous));
  await hub.answer({ ok: false, unknown: true }, hub.commands().at(-1));
  const restore = await screen.findByRole("button", { name: "入力欄に戻す" });
  expect(screen.getByText("Gasho サーバーとの接続が切れたので、送れたか分かりません。会話に出ているか確認してください。出なければ、入力欄に戻して、もう一度送ってください。")).toBeTruthy();
  expect(box.value).toBe("");
  await user.click(restore);
  expect(box.value).toBe("続けて");
});

for (const { reason, agent, nextStatus, oldDaemon } of [
  { reason: "Codex model/list fails", agent: "codex", nextStatus: "idle", oldDaemon: false },
  { reason: "Antigravity reconnects", agent: "antigravity", nextStatus: "unknown", oldDaemon: false },
  { reason: "the daemon downgrades", agent: "codex", nextStatus: "idle", oldDaemon: true },
] as const) {
  test(`hidden model and Effort picks are discarded when ${reason}`, async () => {
    const levels = [{ id: "regular", name: "Regular" }, { id: "deep", name: "Deep" }];
    const s = session("s", {
      agent,
      agentConfig: {
        model: { current: "base", options: [{ id: "base", name: "Base", efforts: levels }, { id: "pro", name: "Pro Model", efforts: levels }] },
        effort: { current: "regular", options: levels },
      },
    });
    const m = machine(reason, [s], { agents: { [agent]: { status: "available", operations: ["model", "effort"] } } });
    const hub = await connectHub({ machines: [m] });
    render(<SessionView machine={m.id} sessionId={s.sessionId} onSessionAction={() => {}} onAskTrust={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^モデル：Base/ }));
    await user.click(screen.getByRole("option", { name: "Pro Model" }));
    if (agent === "codex") {
      await user.click(screen.getByRole("button", { name: /^Effort：/ }));
      await user.click(screen.getByRole("menuitemradio", { name: "Deep" }));
    }

    const withoutOptions = oldDaemon
      ? { ...m, daemonVersion: "0.38.1", agents: { [agent]: { status: "available" as const, operations: [] } } }
      : { ...m, sessions: [{ ...s, status: nextStatus, agentConfig: undefined }] };
    await hub.say({ type: "machine", machine: withoutOptions });
    expect(screen.queryByRole("button", { name: /^モデル：/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Effort：/ })).toBeNull();
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "メッセージ" });
    for (const text of ["候補が消えたあと", "候補が戻ったあと"]) {
      await user.type(box, text);
      await user.click(screen.getByRole("button", { name: "送信" }));
      await waitFor(() => expect(hub.commands().at(-1)).toMatchObject({ type: "session.input", text }));
      expect(hub.commands().at(-1)).not.toHaveProperty("agentSelection");
      await hub.answer({ ok: true }, hub.commands().at(-1));
      await hub.say({ type: "machine", machine: m });
    }
  });
}

test("Antigravity keeps the old Effort pick until the model changes and never sends it with the switch", async () => {
  const options = [{ id: "regular", name: "Regular" }, { id: "deep", name: "Deep" }];
  const model = { current: "base", options: [{ id: "base", name: "Base" }, { id: "pro", name: "Pro Model" }] };
  const effort = { current: "regular", options };
  const s = session("s", { agent: "antigravity", agentConfig: { model, effort } });
  const m = machine("antigravity-effort", [s], { agents: { antigravity: { status: "available", operations: ["model", "effort"] } } });
  const hub = await connectHub({ machines: [m] });
  render(<SessionView machine={m.id} sessionId={s.sessionId} onSessionAction={() => {}} onAskTrust={() => {}} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Effort：Regular" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Deep" }));
  await user.click(screen.getByRole("button", { name: /^モデル：Base/ }));
  await user.click(screen.getByRole("option", { name: "Pro Model" }));
  const disabled = screen.getByRole<HTMLButtonElement>("button", { name: "Effort：Regular（モデルを切り替えたあとに選べます）" });
  expect(disabled.disabled).toBe(true);
  expect(disabled.title).toBe("モデルを切り替えたあとに選べます");

  await user.click(screen.getByRole("button", { name: /^モデル：Pro Model/ }));
  await user.click(screen.getByRole("option", { name: /^Base/ }));
  expect(screen.getByRole("button", { name: "Effort：Deep（送るときに切り替えます）" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: /^モデル：Base/ }));
  await user.click(screen.getByRole("option", { name: "Pro Model" }));
  const box = screen.getByRole("textbox", { name: "メッセージ" });
  await user.type(box, "モデルを替えて");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() => expect(hub.commands().at(-1)).toMatchObject({ text: "モデルを替えて" }));
  expect(hub.commands().at(-1)).toHaveProperty("agentSelection", { model: "pro" });
  await hub.answer({ ok: true }, hub.commands().at(-1));

  await hub.say({ type: "machine", machine: { ...m, sessions: [{ ...s, agentConfig: { model: { ...model, current: "pro" }, effort } }] } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Effort：Regular" }).disabled).toBe(false);
  await user.type(box, "続けて");
  await user.click(screen.getByRole("button", { name: "送信" }));
  await waitFor(() => expect(hub.commands().at(-1)).toMatchObject({ text: "続けて" }));
  expect(hub.commands().at(-1)).not.toHaveProperty("agentSelection");
  await hub.answer({ ok: true }, hub.commands().at(-1));
});
