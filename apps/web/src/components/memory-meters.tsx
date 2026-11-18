// The home screen's tile of the working servers' memory: for each, its name, the share in use and how much that is. The
// level is told in words as well as by color. An offline server shows no old value, and one whose gasho-daemon does not
// tell its memory says so.
import type { MachineInfo, MachineMemory } from "@gasho/protocol";
import { CHART_BLUE } from "@/components/ui/stat-card";
import { cn } from "@/lib/utils";

const CAUTION_PERCENT = 80;
const WARNING_PERCENT = 90;
const GB = 1024 ** 3;

type MemoryLevel = "normal" | "caution" | "warning";

const LEVELS: Record<MemoryLevel, { word?: string; color: string; text: string }> = {
  normal: { color: CHART_BLUE, text: "text-foreground" },
  caution: { word: "注意", color: "#f59e0b", text: "text-amber-600 dark:text-amber-400" },
  warning: { word: "警告", color: "#ef4444", text: "text-red-600 dark:text-red-400" },
};

/** The share in use as it is shown, in whole percents. */
export function memoryPercent({ used, total }: MachineMemory): number {
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** Of the percent shown, so that the color never disagrees with the number beside it. */
export function memoryLevel(percent: number): MemoryLevel {
  if (percent >= WARNING_PERCENT) return "warning";
  return percent >= CAUTION_PERCENT ? "caution" : "normal";
}

const gigabytes = (bytes: number) => (bytes / GB).toFixed(1);

function Meter({ name, memory }: { name: string; memory: MachineMemory }) {
  const percent = memoryPercent(memory);
  const level = LEVELS[memoryLevel(percent)];
  const amount = `${gigabytes(memory.used)} / ${gigabytes(memory.total)} GB`;
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
        <span className={cn("shrink-0 text-sm font-medium tabular-nums", level.text)}>
          {level.word && <span className="mr-1.5 text-xs">{level.word}</span>}
          {percent}%
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${name} のメモリ使用率`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%${level.word ? `（${level.word}）` : ""}、${amount}`}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]"
      >
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, backgroundColor: level.color }} />
      </div>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">{amount}</p>
    </>
  );
}

export function MemoryMeters({ machines, memory }: { machines: MachineInfo[]; memory: Record<string, MachineMemory> }) {
  if (machines.length === 0) return <p className="text-sm text-muted-foreground">登録された working server はありません。</p>;
  return (
    <ul className="space-y-3">
      {machines.map((m) => {
        const known = m.connected ? memory[m.id] : undefined;
        return (
          <li key={m.id}>
            {known ? (
              <Meter name={m.name} memory={known} />
            ) : (
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{m.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{m.connected ? "未対応" : "オフライン"}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
