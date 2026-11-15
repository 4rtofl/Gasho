// The database across versions of the Gasho server: an older one opens a newer database as it is (going back after an
// update), unless the newer one wrote that it needs at least its own schema (min_schema); `check-db` says which.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION, Store } from "../src/store.ts";

function dbFile(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gasho-store-")), "hub.db");
  new Store(file).close();
  return file;
}

/** What a newer version could have done: an additive migration, and maybe min_schema. */
function newer(file: string, min?: number): void {
  const db = new DatabaseSync(file);
  db.exec(`ALTER TABLE devices ADD COLUMN color TEXT; CREATE TABLE later (x TEXT); PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  if (min !== undefined) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('min_schema', ?)").run(String(min));
  db.close();
}

const userVersion = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  const v = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  db.close();
  return v;
};

test("an older Gasho server opens a newer database as it is, and keeps working in it", () => {
  const file = dbFile();
  const kept = new Store(file);
  const browser = kept.createDevice("browser", "iPhone");
  kept.close();
  newer(file);
  const store = new Store(file);
  assert.ok(store.listDevices().some((d) => d.id === browser.device.id));
  store.createDevice("machine", "ubuntu");
  assert.equal(store.listDevices().length, 2);
  store.close();
  // Its schema is not taken back.
  assert.equal(userVersion(file), SCHEMA_VERSION + 1);
});

test("a database that needs a newer schema is not opened, and says why", () => {
  const file = dbFile();
  newer(file, SCHEMA_VERSION + 1);
  assert.throws(() => new Store(file), new RegExp(`schema ${SCHEMA_VERSION + 1} 以上の新しい Gasho サーバーでしか開けません（この版は schema ${SCHEMA_VERSION}）`));
  const ok = dbFile();
  newer(ok, SCHEMA_VERSION);
  new Store(ok).close();
});

test("check-db opens a database (as an update checks a copy) and fails with why", () => {
  const cli = path.resolve(import.meta.dirname, "../src/cli.ts");
  const env = { ...process.env, GASHO_HUB_ENV: "off", GASHO_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-layout-")) };
  const run = (file: string) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "check-db", file], { env, encoding: "utf8" });
  const good = dbFile();
  const r = run(good);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "ok");

  const bad = dbFile();
  newer(bad, SCHEMA_VERSION + 5);
  const refused = run(bad);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /新しい Gasho サーバーでしか開けません/);
});
