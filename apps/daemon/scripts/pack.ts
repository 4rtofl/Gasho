// Builds the npm package of gasho-daemon (@4rtofl/gasho-daemon on GitHub Packages) in dist/package: the TypeScript
// compiled to JavaScript (Node.js does not run TypeScript inside node_modules), the Rust terminal hosts built in
// native/ (terminal-host.ts), a package.json and a README. The version is DAEMON_VERSION, the one gasho-daemon tells the
// Gasho server. Publish with `npm publish dist/package`. With GASHO_NATIVE_REQUIRED=1 (the release), a terminal host
// missing for one of RELEASE_TARGETS fails the build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "../src/install.ts";
import { BINARY, NATIVE_DIR, RELEASE_TARGETS, SOURCE_FILE, sourceHash } from "./terminal-host.ts";

const daemon = path.resolve(import.meta.dirname, "..");
const out = path.join(daemon, "dist/package");
const version = /export const DAEMON_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(daemon, "src/daemon.ts"), "utf8"))?.[1];
if (!version) throw new Error("DAEMON_VERSION not found in src/daemon.ts");

fs.rmSync(out, { recursive: true, force: true });
const tsc = path.resolve(daemon, "../../node_modules/.bin/tsc");
execFileSync(tsc, ["-p", path.join(daemon, "tsconfig.build.json"), "--outDir", path.join(out, "lib")], { stdio: "inherit" });
fs.chmodSync(path.join(out, "lib/cli.js"), 0o755);
// The plugin that gasho-daemon loads into the sessions it starts (src/agent-worktrees.ts), next to lib/.
fs.cpSync(path.join(daemon, "claude-plugin"), path.join(out, "claude-plugin"), { recursive: true });

// The Rust terminal hosts (terminal.ts takes the one for its machine, if any), only those built from this source.
const source = sourceHash();
const platforms = fs.existsSync(NATIVE_DIR) ? fs.readdirSync(NATIVE_DIR).filter((p) => fs.existsSync(path.join(NATIVE_DIR, p, BINARY))).sort() : [];
for (const platform of platforms) {
  const stamp = path.join(NATIVE_DIR, platform, SOURCE_FILE);
  const built = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8").trim() : undefined;
  if (built !== source) throw new Error(`native/${platform} was built from another source of the terminal host: build it again (scripts/terminal-host.ts)`);
  fs.mkdirSync(path.join(out, "native", platform), { recursive: true });
  fs.copyFileSync(path.join(NATIVE_DIR, platform, BINARY), path.join(out, "native", platform, BINARY));
  // An artifact of GitHub Actions does not keep the mode.
  fs.chmodSync(path.join(out, "native", platform, BINARY), 0o755);
}
const missing = Object.keys(RELEASE_TARGETS).filter((p) => !platforms.includes(p));
if (process.env.GASHO_NATIVE_REQUIRED === "1" && missing.length > 0) throw new Error(`no terminal host built for ${missing.join(", ")} in native/`);

// The daemon's own dependencies (the sessions' terminals: node-pty and xterm.js), at the versions it was tested with;
// the workspace's packages (@gasho/protocol) are only types, gone in the JavaScript.
const own = JSON.parse(fs.readFileSync(path.join(daemon, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const dependencies = Object.fromEntries(Object.entries(own.dependencies ?? {}).filter(([name]) => !name.startsWith("@gasho/")));

const pkg = {
  name: PACKAGE_NAME,
  version,
  description: "gasho-daemon: Gasho の working server で動き、Claude Code のセッションを Gasho サーバーにつなぐ",
  type: "module",
  bin: { "gasho-daemon": "lib/cli.js" },
  files: ["lib", "claude-plugin", ...(platforms.length > 0 ? ["native"] : [])],
  dependencies,
  engines: { node: ">=24" },
  repository: { type: "git", url: "git+https://github.com/4rtofl/Gasho.git", directory: "apps/daemon" },
  homepage: "https://github.com/4rtofl/Gasho/blob/main/docs/daemon-setup.md",
  publishConfig: { registry: "https://npm.pkg.github.com" },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(
  path.join(out, "README.md"),
  `# ${PACKAGE_NAME}

Gasho の gasho-daemon。Claude Code を動かすマシン（working server）で動かし、セッションの様子を Gasho サーバーに送る。

\`\`\`bash
npx ${PACKAGE_NAME} register --server http://<Gasho サーバー>:7740 --code <コード>
npx ${PACKAGE_NAME} doctor
\`\`\`

GitHub Packages から入れるための設定と、常駐のさせ方は [docs/daemon-setup.md](https://github.com/4rtofl/Gasho/blob/main/docs/daemon-setup.md) を見る。
`,
);
console.log(`built ${PACKAGE_NAME}@${version} in ${path.relative(process.cwd(), out) || "."} (terminal hosts: ${platforms.join(", ") || "none"})`);
