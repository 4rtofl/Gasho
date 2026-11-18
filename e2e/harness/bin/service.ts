#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// What systemd (Restart=on-failure) and launchd do for the Gasho server's service, for a test (hub-service.ts): runs
// `node <launcher> start`, and starts it again a second after it ends with anything but 0 (an update ends with 75),
// unless the test holds the restarts (the control file). SIGUSR2 kills the Gasho server at once, as a crash; SIGTERM
// stops it and this. A Gasho server that never listened (its port was taken meanwhile) is not started again: this ends
// with it, for the test to start it on another port.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";

const launcher = process.argv[2] ?? "";
const control = process.argv[3] ?? "";
if (!launcher || !control) throw new Error("usage: service.ts <launcher> <control file>");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${new Date().toISOString()} [service] ${s}`);

function held(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(control, "utf8")) as { hold?: unknown }).hold === true;
  } catch {
    return false;
  }
}

let child: ChildProcess | undefined;
let stopping = false;
let listened = false;

function start(): void {
  const c = spawn(process.execPath, [launcher, "start"], { stdio: ["ignore", "pipe", "inherit"] });
  child = c;
  let tail = "";
  c.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    // With the end of the chunk before, for a line split between two.
    const text = tail + chunk.toString("utf8");
    if (/listening on /.test(text)) listened = true;
    tail = text.slice(-100);
  });
  c.on("exit", (code, signal) => {
    child = undefined;
    if (stopping || code === 0) process.exit(0);
    if (!listened) process.exit(code ?? 1);
    log(`gasho-hub ended (${signal ?? code}); starting it again`);
    void again();
  });
}

async function again(): Promise<void> {
  await sleep(1000);
  while (held() && !stopping) await sleep(200);
  if (!stopping) start();
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill("SIGTERM");
    else process.exit(0);
  });
}
process.on("SIGUSR2", () => child?.kill("SIGKILL"));

// The test runner ended without stopping this (killed): the Gasho server goes with it.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid === parent) return;
  child?.kill("SIGKILL");
  process.exit(1);
}, 1000).unref();

start();
