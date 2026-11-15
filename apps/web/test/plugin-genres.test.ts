import assert from "node:assert/strict";
import { test } from "node:test";
import type { CatalogPlugin, PluginCatalog, PluginInfo } from "@gasho/protocol";
import { byGenre, genreName, genreOf } from "../src/lib/plugin-genres.ts";

const plugin = (id: string, genre?: string): CatalogPlugin => ({
  id,
  name: id,
  version: "1.0.0",
  api: "1.0",
  daemon: false,
  release: `${id}-v1.0.0`,
  file: `${id}-1.0.0.tgz`,
  sha256: "0".repeat(64),
  size: 1,
  ...(genre ? { genre } : {}),
});
const info = (id: string, genre?: string): PluginInfo => ({ id, manifest: { id, name: id, version: "1.0.0", api: "1.0", ...(genre ? { genre } : {}) }, dev: false, enabled: true, values: {} });
const genres = [
  { id: "integration", name: "連携" },
  { id: "workflow", name: "作業の管理" },
  { id: "devtools", name: "開発ツール" },
];
const catalog: PluginCatalog = { repo: "o/plugins", plugins: [plugin("github", "integration"), plugin("kanban", "workflow")], genres };

test("an installed plugin's genre is its own, or else the catalog's for it; its name comes from the catalog", () => {
  assert.equal(genreOf(info("github"), catalog), "integration");
  assert.equal(genreOf(info("github", "devtools"), catalog), "devtools");
  assert.equal(genreOf(info("mine"), catalog), undefined);
  assert.equal(genreOf(info("github"), undefined), undefined);
  assert.equal(genreName(catalog, "workflow"), "作業の管理");
  assert.equal(genreName(catalog, "nope"), undefined);
  assert.equal(genreName(catalog, undefined), undefined);
  assert.equal(genreName({ ...catalog, genres: undefined }, "workflow"), undefined);
});

test("the catalog's plugins are listed by genre in the catalog's order, those of no genre it lists last", () => {
  const groups = byGenre([plugin("b", "devtools"), plugin("a", "integration"), plugin("c"), plugin("d", "devtools"), plugin("e", "gone")], genres);
  assert.deepEqual(
    groups?.map((g) => [g.genre?.id, g.plugins.map((p) => p.id)]),
    [
      ["integration", ["a"]],
      ["devtools", ["b", "d"]],
      [undefined, ["c", "e"]],
    ],
  );
  // A catalog that lists no genres is not split.
  assert.equal(byGenre([plugin("a", "integration")], undefined), undefined);
  assert.equal(byGenre([plugin("a", "integration")], []), undefined);
  assert.deepEqual(byGenre([], genres), []);
});
