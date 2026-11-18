import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MemoryMeters, memoryLevel, memoryPercent } from "@/components/memory-meters";
import { useAppState } from "@/lib/store";
import { connectHub, machine } from "./hub";

const GB = 1024 ** 3;
const memory = (used: number, total = 16) => ({ used: used * GB, total: total * GB });

function Tile() {
  const { machines, memory: known } = useAppState();
  return <MemoryMeters machines={machines} memory={known} />;
}

test("the level changes at 80% and at 90% of what is shown", () => {
  expect([79, 80, 89, 90, 100].map(memoryLevel)).toEqual(["normal", "caution", "caution", "warning", "warning"]);
  // 79.6% is shown as 80%: the color goes with the number.
  expect(memoryLevel(memoryPercent({ used: 796, total: 1000 }))).toBe("caution");
  expect(memoryPercent({ used: 20, total: 10 })).toBe(100);
});

test("an online server shows its name, share and amount, and follows the values it is sent", async () => {
  const hub = await connectHub({ machines: [machine("m1", [], { name: "Ubuntu" })], memory: { m1: memory(8) } });
  render(<Tile />);
  expect(screen.getByText("Ubuntu")).toBeTruthy();
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("8.0 / 16.0 GB")).toBeTruthy();
  expect(screen.getByRole("meter", { name: "Ubuntu のメモリ使用率" }).getAttribute("aria-valuenow")).toBe("50");

  await hub.say({ type: "machine.memory", machine: "m1", memory: memory(13.6) });
  expect(screen.getByText("85%")).toBeTruthy();
  expect(screen.getByText("注意")).toBeTruthy();

  await hub.say({ type: "machine.memory", machine: "m1", memory: memory(15.2) });
  expect(screen.getByText("95%")).toBeTruthy();
  expect(screen.getByText("警告")).toBeTruthy();
  expect(screen.queryByText("注意")).toBeNull();
});

test("a server that goes offline shows no old value", async () => {
  const hub = await connectHub({ machines: [machine("m1", [], { name: "Ubuntu" })], memory: { m1: memory(8) } });
  render(<Tile />);
  await hub.say({ type: "machine", machine: machine("m1", [], { name: "Ubuntu", connected: false }) });
  expect(screen.getByText("オフライン")).toBeTruthy();
  expect(screen.queryByText("50%")).toBeNull();
  expect(screen.queryByRole("meter")).toBeNull();
});

test("a server whose gasho-daemon does not tell its memory, or a Gasho server older than the meters, shows 未対応", async () => {
  await connectHub({ machines: [machine("m1", [], { name: "Old" })] });
  render(<Tile />);
  expect(screen.getByText("未対応")).toBeTruthy();
  expect(screen.queryByRole("meter")).toBeNull();
});

test("a value that is no longer known is taken off the meter", async () => {
  const hub = await connectHub({ machines: [machine("m1", [], { name: "Ubuntu" })], memory: { m1: memory(8) } });
  render(<Tile />);
  await hub.say({ type: "machine.memory", machine: "m1" });
  expect(screen.getByText("未対応")).toBeTruthy();
});
