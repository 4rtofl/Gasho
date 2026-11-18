import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryOfMeminfo, memoryOfVmStat } from "../src/memory.ts";

test("on Linux, used memory is MemTotal - MemAvailable: the page cache does not count", () => {
  const meminfo = ["MemTotal:       16000000 kB", "MemFree:          400000 kB", "MemAvailable:    6000000 kB", "Cached:          5000000 kB"].join("\n");
  assert.deepEqual(memoryOfMeminfo(meminfo), { total: 16000000 * 1024, used: 10000000 * 1024 });
});

test("a meminfo without MemAvailable or MemTotal tells nothing", () => {
  assert.equal(memoryOfMeminfo("MemTotal:       16000000 kB\nMemFree:          400000 kB\n"), undefined);
  assert.equal(memoryOfMeminfo("MemAvailable:    6000000 kB\n"), undefined);
  assert.equal(memoryOfMeminfo(""), undefined);
});

const vmStat = (extra = "") =>
  `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          190000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         60000.
Pages purgeable:                           4000.
"Translation faults":                 123456789.
File-backed pages:                       150000.
Anonymous pages:                         240000.
Pages stored in compressor:               90000.
Pages occupied by compressor:             30000.
${extra}`;

test("on macOS, used memory is the apps', wired and compressed memory: the file cache does not count", () => {
  const total = 16 * 1024 ** 3;
  assert.deepEqual(memoryOfVmStat(vmStat(), total), { total, used: (240000 - 4000 + 60000 + 30000) * 16384 });
});

test("a vm_stat that cannot be read tells nothing, and used never passes the total", () => {
  assert.equal(memoryOfVmStat("vm_stat: failed", 1024), undefined);
  assert.equal(memoryOfVmStat(vmStat().replace("Pages wired down", "Wired"), 1024), undefined);
  assert.equal(memoryOfVmStat(vmStat(), 0), undefined);
  assert.deepEqual(memoryOfVmStat(vmStat(), 1024), { total: 1024, used: 1024 });
});
