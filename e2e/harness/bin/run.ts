// What the fakes share: record the call, then give the first answer of the table that fits it (fakes.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callsFile, type FakeName, type FakeTable, matches, readTable } from "../fakes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a fake. `builtIn` answers what the table does not (claude's sessions and control requests); it gives the exit
 * code, or undefined when it has no answer either.
 */
export async function runFake<T extends FakeTable>(name: FakeName, builtIn?: (table: T, args: string[]) => Promise<number | undefined>): Promise<never> {
  const args = process.argv.slice(2);
  const home = os.homedir();
  // Not made when it is not there: the test is over, and its folder removed (a call that gasho-daemon started just
  // before it was stopped).
  await fs.appendFile(callsFile(home, name), `${JSON.stringify({ args, cwd: process.cwd(), at: Date.now() })}\n`).catch(() => undefined);
  const table = await readTable<T>(home, name);
  const answer = table.answers?.find((a) => matches(a.args, args));
  if (answer) {
    if (answer.delayMs) await sleep(answer.delayMs);
    const i = args.indexOf("--output");
    const out = i >= 0 ? args[i + 1] : undefined;
    if (out && answer.output !== undefined) await fs.writeFile(out, answer.output);
    if (out && answer.outputFile !== undefined) await fs.copyFile(answer.outputFile, out);
    if (answer.copyInto) await fs.cp(answer.copyInto.from, path.join(process.cwd(), answer.copyInto.to), { recursive: true, verbatimSymlinks: true });
    if (answer.stdout) process.stdout.write(answer.stdout);
    if (answer.stderr) process.stderr.write(answer.stderr);
    return exit(answer.exitCode ?? 0);
  }
  const code = await builtIn?.(table, args);
  if (code !== undefined) return exit(code);
  process.stderr.write(`fake ${name}: no answer for: ${args.join(" ")}\n`);
  return exit(1);
}

/** Ends once what was written has gone out (a pipe takes it in parts). */
function exit(code: number): Promise<never> {
  return new Promise(() => {
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  });
}
