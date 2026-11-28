import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ActivityHeatmap } from "@/components/ui/activity-heatmap";
import { arrangeTiles } from "@/lib/order";
import { useAppState } from "@/lib/store";
import { mergeTokenDays, sumTokenDays, tokenDayOf } from "@/lib/token-days";
import { TokenHeatmap } from "@/views/home";
import { connectHub, machine } from "./hub";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Makes the heatmap measure `width` px. */
function measure(width: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
}

test("a day ends at midnight in Japan", () => {
  expect(tokenDayOf(Date.parse("2026-11-17T14:59:59Z"))).toBe("2026-11-17");
  expect(tokenDayOf(Date.parse("2026-11-17T15:00:00Z"))).toBe("2026-11-18");
});

test("the working servers' days are added together, and a day told again replaces its total", () => {
  expect(sumTokenDays({ a: [["2026-11-18", 5], ["2026-11-17", 1]], b: [["2026-11-18", 7]] })).toEqual([
    { date: "2026-11-17", value: 1 },
    { date: "2026-11-18", value: 12 },
  ]);
  expect(mergeTokenDays([["2026-11-17", 1], ["2026-11-18", 5]], [["2026-11-18", 9]])).toEqual([["2026-11-17", 1], ["2026-11-18", 9]]);
});

test("the summary, the labels and the tooltip are in Japanese, with numbers in the form given", () => {
  measure(900);
  const { container } = render(
    <ActivityHeatmap data={[{ date: "2026-11-18", value: 76_000 }]} endDate="2026-11-18" unit="トークン" format={(n) => `${n / 10_000}万`} animated={false} />,
  );
  expect(screen.getByText("過去1年で 7.6万 トークン")).toBeTruthy();
  expect(screen.getByText("水")).toBeTruthy();
  expect(container.textContent).toContain("11月");
  const svg = screen.getByRole("img");
  fireEvent.keyDown(svg, { key: "ArrowDown" });
  fireEvent.keyDown(svg, { key: "ArrowDown" });
  fireEvent.keyDown(svg, { key: "ArrowDown" });
  expect(screen.getByRole("status").textContent).toBe("2026年11月18日(水)：7.6万 トークン");
});

test("a narrow tile leaves out the oldest weeks and keeps today", () => {
  measure(300);
  const { container } = render(<ActivityHeatmap data={[{ date: "2026-11-18", value: 5 }]} endDate="2026-11-18" unit="トークン" animated={false} />);
  const cells = [...container.querySelectorAll("rect[data-level]")];
  const right = Math.max(...cells.map((r) => Number(r.getAttribute("x")) + Number(r.getAttribute("width"))));
  expect(right).toBeLessThanOrEqual(300);
  expect(cells.length).toBeLessThan(53 * 7);
  expect(cells.filter((r) => r.getAttribute("data-level") !== "0")).toHaveLength(1);
});

test("without animation the cells are not animated", () => {
  measure(900);
  const { container } = render(<ActivityHeatmap data={[]} endDate="2026-11-18" unit="トークン" animated={false} />);
  expect(container.querySelector(".heat-cell")).toBeNull();
});

test("the home screen asks for the days and says when there are none, or only older gasho-daemons", async () => {
  measure(900);
  const hub = await connectHub({ machines: [machine("m1")] });
  render(<TokenHeatmap now={Date.now()} />);
  expect(hub.sent.some((m) => m.type === "token.days.get")).toBe(true);

  await hub.say({ type: "token.days", days: {}, reported: false });
  expect(screen.getByText(/gasho-daemon を更新すると/)).toBeTruthy();

  await hub.say({ type: "token.days", days: {}, reported: true });
  expect(screen.getByText(/まだトークンの使用量はありません/)).toBeTruthy();

  await hub.say({ type: "token.days.update", machine: "m1", days: [[tokenDayOf(Date.now()), 75_808]] });
  expect(screen.getByText("過去1年で 7.6万 トークン")).toBeTruthy();
});

test("the days of a working server taken off are no longer counted", async () => {
  const hub = await connectHub({ machines: [machine("m1")] });
  let days: unknown;
  function Probe() {
    days = useAppState().tokenDays;
    return null;
  }
  render(<Probe />);
  await hub.say({ type: "token.days", days: { m1: [["2026-11-18", 5]] }, reported: true });
  await hub.say({ type: "machine.removed", id: "m1" });
  expect(days).toEqual({});
});

test("a browser that saved its order before the tile existed gets the tile too", () => {
  expect(arrangeTiles(["tokens", "tokenBreakdown", "tokenHeatmap", "operations"], ["operations", "tokenBreakdown", "tokens"])).toContain("tokenHeatmap");
});

const installed = { status: "available" as const };

test.each([
  ["Claude Code alone", {}, "日本時間で1日を区切っています（サブエージェントを含む）。"],
  ["with Codex", { codex: installed }, "日本時間で1日を区切っています。Claude Code はサブエージェントを含みます。Codex はサブエージェントを除きます。"],
])("the note on what the days hold: %s", async (_name, agents, note) => {
  measure(900);
  const hub = await connectHub({ machines: [machine("m1", [], { agents })] });
  render(<TokenHeatmap now={Date.now()} />);
  await hub.say({ type: "token.days", days: { m1: [[tokenDayOf(Date.now()), 5]] }, reported: true });
  expect(screen.getByText(note)).toBeTruthy();
});
