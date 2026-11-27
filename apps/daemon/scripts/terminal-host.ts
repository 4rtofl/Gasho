// Builds the Rust terminal host (terminal-host/, a Cargo crate) into native/<platform>-<arch>/, where terminal.ts finds
// it and pack.ts takes it into the npm package. Needs cargo.
//
//   node apps/daemon/scripts/terminal-host.ts                       for this machine
//   node apps/daemon/scripts/terminal-host.ts <platform>-<arch>     for one of RELEASE_TARGETS (the release builds each
//                                                                   on a runner of its own: .github/workflows/release.yml)
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const daemon = path.resolve(import.meta.dirname, "..");
const crate = path.join(daemon, "terminal-host");
export const NATIVE_DIR = path.join(daemon, "native");
export const BINARY = "gasho-terminal-host";
/** Beside each binary: the sourceHash it was built from. */
export const SOURCE_FILE = "source";
/** The machines the npm package has the Rust host for (as Node.js names them), and Rust's target for each. */
export const RELEASE_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  // musl, linked statically: it runs whatever glibc the machine has.
  "linux-x64": "x86_64-unknown-linux-musl",
};

/** A hash of the crate's source (all but target/), so that no binary built from another source gets into a package. */
export function sourceHash(): string {
  const h = crypto.createHash("sha256");
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(crate, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = path.posix.join(dir, e.name);
      if (rel === "target") continue;
      if (e.isDirectory()) walk(rel);
      else h.update(`${rel}\0`).update(fs.readFileSync(path.join(crate, rel))).update("\0");
    }
  };
  walk("");
  return h.digest("hex");
}

function build(platform: string, target: string | undefined): void {
  if (target) execFileSync("rustup", ["target", "add", target], { stdio: "inherit" });
  const args = ["build", "--release", "--locked", "--manifest-path", path.join(crate, "Cargo.toml"), ...(target ? ["--target", target] : [])];
  execFileSync("cargo", args, { stdio: "inherit" });
  const built = path.join(crate, "target", ...(target ? [target] : []), "release", BINARY);
  const dir = path.join(NATIVE_DIR, platform);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(built, path.join(dir, BINARY));
  fs.chmodSync(path.join(dir, BINARY), 0o755);
  fs.writeFileSync(path.join(dir, SOURCE_FILE), `${sourceHash()}\n`);
  console.log(`built ${path.relative(process.cwd(), path.join(dir, BINARY))}`);
}

if (import.meta.main) {
  const platform = process.argv[2];
  if (platform === undefined) {
    build(`${process.platform}-${process.arch}`, undefined);
  } else if (RELEASE_TARGETS[platform]) {
    build(platform, RELEASE_TARGETS[platform]);
  } else {
    console.error(`usage: node apps/daemon/scripts/terminal-host.ts [${Object.keys(RELEASE_TARGETS).join(" | ")}]`);
    process.exit(2);
  }
}
