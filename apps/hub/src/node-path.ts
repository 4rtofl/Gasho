// The Node.js the service's file names. process.execPath is the real file, and Homebrew keeps that under a folder named
// for its version (/opt/homebrew/Cellar/node/26.13.0_1/bin/node), which `brew upgrade` and `brew cleanup` remove; the
// service could not start any more. Homebrew's links to it keep their names across versions, so the service names one
// of them instead. A Node.js put in by hand (~/.local/opt/node-v24.22.2-linux-x64) stays until its owner removes it,
// so its path is kept as it is. Copied from gasho-daemon's (apps/daemon/src/node-path.ts).
import fs from "node:fs";

/** Homebrew's folder of a version of its node formula: the prefix it is under, and the formula (node, node@24). */
export function cellarNode(node: string): { prefix: string; formula: string } | undefined {
  const m = /^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/.exec(node);
  return m ? { prefix: m[1] || "/", formula: m[2]! } : undefined;
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}

/**
 * A path to `node` that stays the same across Homebrew's versions and leads to the same file: the formula's link in
 * opt (there for keg-only formulas such as node@24 too), then the one in bin. Any other path, or one whose links lead
 * elsewhere (another formula linked in bin), is kept as it is.
 */
export function stableNode(node: string, realpath: (file: string) => string | undefined = realpathOrUndefined): string {
  const cellar = cellarNode(node);
  if (!cellar) return node;
  const target = realpath(node);
  if (!target) return node;
  const { prefix, formula } = cellar;
  const join = (...parts: string[]) => [prefix === "/" ? "" : prefix, ...parts].join("/");
  for (const link of [join("opt", formula, "bin", "node"), join("bin", "node")]) {
    if (realpath(link) === target) return link;
  }
  return node;
}
