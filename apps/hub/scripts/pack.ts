// Builds the npm package of the Gasho server (@4rtofl/gasho-hub on GitHub Packages) in dist/package: the TypeScript
// compiled to JavaScript (lib/; Node.js does not run TypeScript inside node_modules), the screen built for this version
// (web/), a package.json and a README. The version is HUB_VERSION (src/version.ts), the one the Gasho server tells
// browsers; GASHO_PACK_VERSION packs a trial package under another one (a release checks that it was built with its
// own, scripts/release.ts). Publish with `npm publish dist/package`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "../src/install.ts";

const hub = path.resolve(import.meta.dirname, "..");
const root = path.resolve(hub, "../..");
const out = path.join(hub, "dist/package");
const source = /export const HUB_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(hub, "src/version.ts"), "utf8"))?.[1];
if (!source) throw new Error("HUB_VERSION not found in src/version.ts");
const version = process.env.GASHO_PACK_VERSION || source;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a version of the form x.y.z: ${version}`);

fs.rmSync(out, { recursive: true, force: true });
execFileSync(path.join(root, "node_modules/.bin/tsc"), ["-p", path.join(hub, "tsconfig.build.json"), "--outDir", path.join(out, "lib")], { stdio: "inherit" });
fs.chmodSync(path.join(out, "lib/cli.js"), 0o755);
if (version !== source) {
  // A trial package says the version it is packed as.
  const file = path.join(out, "lib/version.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`"${source}"`, `"${version}"`));
}

// The screen, built with this version as its build: a page of another build reloads when it connects again.
execFileSync("npm", ["run", "build", "-w", "@gasho/web"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, GASHO_WEB_BUILD: process.env.GASHO_WEB_BUILD || `hub-${version}` },
});
fs.cpSync(path.join(root, "apps/web/dist"), path.join(out, "web"), { recursive: true });

// Its own dependencies at the versions it was tested with; the workspace's packages (@gasho/protocol) are only types,
// gone in the JavaScript.
const own = JSON.parse(fs.readFileSync(path.join(hub, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
const dependencies = Object.fromEntries(Object.entries(own.dependencies ?? {}).filter(([name]) => !name.startsWith("@gasho/")));

const pkg = {
  name: PACKAGE_NAME,
  version,
  description: "gasho-hub: Gasho のサーバー。ブラウザーと working server の gasho-daemon をつなぎ、Gasho の画面を配る",
  type: "module",
  bin: { "gasho-hub": "lib/cli.js" },
  files: ["lib", "web"],
  dependencies,
  engines: { node: ">=24" },
  repository: { type: "git", url: "git+https://github.com/4rtofl/Gasho.git", directory: "apps/hub" },
  homepage: "https://github.com/4rtofl/Gasho/blob/main/docs/hub-setup.md",
  publishConfig: { registry: "https://npm.pkg.github.com" },
};
fs.writeFileSync(path.join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(
  path.join(out, "README.md"),
  `# ${PACKAGE_NAME}

Gasho のサーバー（gasho-hub）。ブラウザーと、working server の gasho-daemon をつなぎ、Gasho の画面を配る。

\`\`\`bash
npx ${PACKAGE_NAME} service install   # 常駐させる（これからは Gasho の「端末」の画面から更新できる）
npx ${PACKAGE_NAME} pair              # 登録コードを出す
\`\`\`

GitHub Packages から入れるための設定と、常駐のさせ方、更新と自動で前の版に戻す仕組みは [docs/hub-setup.md](https://github.com/4rtofl/Gasho/blob/main/docs/hub-setup.md) を見る。
`,
);
console.log(`built ${PACKAGE_NAME}@${version} in ${path.relative(process.cwd(), out) || "."}`);
