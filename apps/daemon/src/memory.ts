// How much of the working server's memory is in use, for the meters on Gasho's home screen. Memory the system can take
// back at once (the page cache) does not count as used, on Linux and on macOS alike.
import fsp from "node:fs/promises";
import os from "node:os";
import type { MachineMemory } from "@gasho/protocol";
import { exec } from "./exec.ts";

const VM_STAT_TIMEOUT_MS = 5000;

/** /proc/meminfo: used is MemTotal - MemAvailable. Undefined without them (a kernel older than 3.14 has no MemAvailable). */
export function memoryOfMeminfo(text: string): MachineMemory | undefined {
  const kB = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    return m?.[1] === undefined ? undefined : Number(m[1]) * 1024;
  };
  const total = kB("MemTotal");
  const available = kB("MemAvailable");
  if (!total || available === undefined) return undefined;
  return { total, used: Math.max(0, total - available) };
}

/**
 * The output of macOS's vm_stat: used is what Activity Monitor calls Memory Used, the apps' memory (anonymous pages that
 * cannot be purged), wired memory and what the compressor holds. os.freemem() would count the file cache as used.
 */
export function memoryOfVmStat(text: string, total: number): MachineMemory | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\.?$`, "m").exec(text)?.[1]);
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
  if (!(total > 0) || !Number.isFinite(used)) return undefined;
  return { total, used: Math.min(total, Math.max(0, used)) };
}

/** This machine's memory now; undefined when it cannot be told (another system, or a reading that failed). */
export async function readMemory(): Promise<MachineMemory | undefined> {
  try {
    if (process.platform === "linux") return memoryOfMeminfo(await fsp.readFile("/proc/meminfo", "utf8"));
    if (process.platform === "darwin") {
      const { stdout } = await exec("/usr/bin/vm_stat", [], { timeoutMs: VM_STAT_TIMEOUT_MS });
      return memoryOfVmStat(stdout, os.totalmem());
    }
  } catch {
    // Told as not known: the meter must not go on showing an old value.
  }
  return undefined;
}
