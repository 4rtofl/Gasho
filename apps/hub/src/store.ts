// Persists what the Gasho server must remember across restarts: registered devices, pairing codes,
// the last known sessions of each machine, recent hook events and notifications. Uses node:sqlite.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeviceInfo,
  DeviceKind,
  GashoNotification,
  MachineHookEvent,
  MachineInfo,
  NotificationKind,
  PairingCode,
  SessionInfo,
} from "@gasho/protocol";
import { hashSecret, newPairingCode, newToken, normalizeCode, PAIRING_CODE_TTL_MS, sameHash } from "./auth.ts";

/**
 * The schema of the database (PRAGMA user_version). An older Gasho server opens a newer database as it is: going back a
 * version after an update keeps working, so a migration only adds (tables, columns that may be NULL or have a default,
 * indexes, fields of JSON), and drops or changes what the version before reads only a release later. A migration that
 * cannot keep to that writes the lowest schema that may still open the database (min_schema in meta); an older Gasho
 * server then refuses it, rather than spoil it (docs/hub-setup.md).
 */
export const SCHEMA_VERSION = 5;
const EVENT_TTL_MS = 7 * 24 * 3600_000;
const NOTIFICATION_TTL_MS = 30 * 24 * 3600_000;

type Row = Record<string, unknown>;

export interface DeviceRecord extends DeviceInfo {
  revokedAt?: number;
}

function toDevice(r: Row): DeviceRecord {
  return {
    id: String(r.id),
    kind: String(r.kind) as DeviceKind,
    name: String(r.name),
    createdAt: Number(r.created_at),
    lastSeenAt: r.last_seen_at == null ? undefined : Number(r.last_seen_at),
    revokedAt: r.revoked_at == null ? undefined : Number(r.revoked_at),
  };
}

/** A browser's Web Push subscription, as kept. */
export interface PushSubscriptionRecord {
  endpoint: string;
  deviceId: string;
  p256dh: string;
  auth: string;
  kinds: NotificationKind[];
  createdAt: number;
}

function toPushSubscription(r: Row): PushSubscriptionRecord {
  let kinds: NotificationKind[] = [];
  try {
    kinds = JSON.parse(String(r.kinds)) as NotificationKind[];
  } catch {
    // none: nothing is sent to it
  }
  return {
    endpoint: String(r.endpoint),
    deviceId: String(r.device_id),
    p256dh: String(r.p256dh),
    auth: String(r.auth),
    kinds,
    createdAt: Number(r.created_at),
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.migrate();
  }

  private migrate(): void {
    // Additive: an older Gasho server does not read it.
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const min = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'min_schema'").get() as Row | undefined)?.value ?? 0);
    if (min > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`このデータベースは、schema ${min} 以上の新しい Gasho サーバーでしか開けません（この版は schema ${SCHEMA_VERSION}）。Gasho サーバーを新しい版に戻してください。`);
    }
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version >= SCHEMA_VERSION) return;
    if (version < 2) this.migrateTo2();
    // Version 3 adds the plugins: whether each is enabled, where its daemon part runs, and its settings.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        machines TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_settings (
        plugin TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );
      PRAGMA user_version = 3;
    `);
    // Version 4 adds the JSON values that plugins' web parts keep for every browser (useSharedState).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_shared (
        plugin TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );
      PRAGMA user_version = 4;
    `);
    // Version 5 adds the browsers' Web Push subscriptions (the VAPID keys go in meta).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        kinds TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_device ON push_subscriptions(device_id);
      PRAGMA user_version = 5;
    `);
  }

  private migrateTo2(): void {
    // Version 1 keyed machines (and the events and notifications that point at them) by host name.
    // Nothing from it can be mapped to registered machines, so it is dropped.
    this.db.exec(`
      DROP TABLE IF EXISTS machines;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS notifications;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_by TEXT
      );
      CREATE TABLE machines (
        id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL,
        daemon_version TEXT,
        sessions TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX events_at ON events(at);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX notifications_at ON notifications(at);
      PRAGMA user_version = 2;
    `);
  }

  // ---- devices ----

  createDevice(kind: DeviceKind, name: string, now = Date.now()): { device: DeviceRecord; token: string } {
    const id = randomUUID();
    const token = newToken();
    this.db
      .prepare("INSERT INTO devices (id, kind, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, kind, name, hashSecret(token), now);
    return { device: { id, kind, name, createdAt: now }, token };
  }

  /** The device if the token matches and it was not revoked. */
  verifyDevice(id: string, token: string, kind?: DeviceKind): DeviceRecord | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    if (!r || r.revoked_at != null) return undefined;
    if (kind && r.kind !== kind) return undefined;
    if (!sameHash(String(r.token_hash), hashSecret(token))) return undefined;
    return toDevice(r);
  }

  getDevice(id: string): DeviceRecord | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  touchDevice(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  listDevices(): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all() as Row[]).map(
      toDevice,
    );
  }

  revokedSince(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const stmt = this.db.prepare("SELECT revoked_at FROM devices WHERE id = ?");
    return ids.filter((id) => {
      const r = stmt.get(id) as Row | undefined;
      return !r || r.revoked_at != null;
    });
  }

  revokeDevice(id: string, now = Date.now()): boolean {
    const res = this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id);
    if (Number(res.changes) === 0) return false;
    this.db.prepare("DELETE FROM machines WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(id);
    return true;
  }

  renameDevice(id: string, name: string): boolean {
    const res = this.db.prepare("UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL").run(name, id);
    return Number(res.changes) > 0;
  }

  // ---- pairing codes ----

  createPairingCode(createdBy: string, now = Date.now(), ttlMs = PAIRING_CODE_TTL_MS): PairingCode {
    const code = newPairingCode();
    const expiresAt = now + ttlMs;
    this.db
      .prepare("INSERT INTO pairing_codes (code_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?)")
      .run(hashSecret(code), now, expiresAt, createdBy);
    return { code, expiresAt };
  }

  /** Marks the code used; true only for the first use of an unexpired code. */
  consumePairingCode(input: string, now = Date.now()): boolean {
    const res = this.db
      .prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hashSecret(normalizeCode(input)), now);
    return Number(res.changes) === 1;
  }

  // ---- machines ----

  saveMachine(m: MachineInfo): void {
    this.db
      .prepare(
        `INSERT INTO machines (id, last_seen, daemon_version, sessions) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
           daemon_version = excluded.daemon_version, sessions = excluded.sessions`,
      )
      .run(m.id, m.lastSeen, m.daemonVersion ?? null, JSON.stringify(m.sessions));
  }

  /** Registered machines as last seen; all of them start disconnected. */
  loadMachines(): MachineInfo[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, m.last_seen, m.daemon_version, m.sessions
         FROM devices d LEFT JOIN machines m ON m.id = d.id
         WHERE d.kind = 'machine' AND d.revoked_at IS NULL ORDER BY d.name`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      connected: false,
      lastSeen: r.last_seen == null ? 0 : Number(r.last_seen),
      daemonVersion: r.daemon_version == null ? undefined : String(r.daemon_version),
      sessions: r.sessions == null ? [] : (JSON.parse(String(r.sessions)) as SessionInfo[]),
    }));
  }

  // ---- plugins ----

  /** Whether a plugin is enabled; undefined for one never changed (enabled). */
  pluginState(id: string): { enabled: boolean } | undefined {
    const r = this.db.prepare("SELECT enabled FROM plugins WHERE id = ?").get(id) as Row | undefined;
    return r ? { enabled: Number(r.enabled) === 1 } : undefined;
  }

  /**
   * The column machines held where the daemon part ran, when that could be chosen; the daemon part now runs on every
   * working server, and "all" is written for an older Gasho server that reads it.
   */
  setPluginState(id: string, state: { enabled: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled, machines) VALUES (?, ?, '"all"')
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, machines = excluded.machines`,
      )
      .run(id, state.enabled ? 1 : 0);
  }

  /** The settings of a plugin that the Gasho server keeps (scope "server"), as saved. */
  pluginSettings(id: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key, value FROM plugin_settings WHERE plugin = ?").all(id) as Row[]) {
      try {
        out[String(r.key)] = JSON.parse(String(r.value)) as unknown;
      } catch {
        // left out: the default applies
      }
    }
    return out;
  }

  setPluginSetting(id: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO plugin_settings (plugin, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value`,
      )
      .run(id, key, JSON.stringify(value));
  }

  /** The JSON values a plugin's web part keeps for every browser (useSharedState), as saved. */
  pluginShared(id: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.prepare("SELECT key, value FROM plugin_shared WHERE plugin = ?").all(id) as Row[]) {
      try {
        out[String(r.key)] = JSON.parse(String(r.value)) as unknown;
      } catch {
        // left out: the web part's initial value applies
      }
    }
    return out;
  }

  /** Saves a value as JSON text that is already checked (`json`), so that its size is what was counted. */
  setPluginShared(id: string, key: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_shared (plugin, key, value) VALUES (?, ?, ?)
         ON CONFLICT(plugin, key) DO UPDATE SET value = excluded.value`,
      )
      .run(id, key, json);
  }

  /** Forgets a removed plugin: its state, its settings and its shared values. */
  forgetPlugin(id: string): void {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM plugin_settings WHERE plugin = ?").run(id);
    this.db.prepare("DELETE FROM plugin_shared WHERE plugin = ?").run(id);
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- Web Push ----

  /**
   * Keeps a subscription of a browser, or changes its kinds. An endpoint belongs to one browser: taken by another
   * (registered again in the same app), it moves to that one.
   */
  savePushSubscription(s: Omit<PushSubscriptionRecord, "createdAt">, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, kinds, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh,
           auth = excluded.auth, kinds = excluded.kinds`,
      )
      .run(s.endpoint, s.deviceId, s.p256dh, s.auth, JSON.stringify(s.kinds), now);
  }

  /** The subscriptions of a browser, oldest first. */
  pushSubscriptionsOf(deviceId: string): PushSubscriptionRecord[] {
    return (
      this.db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at, endpoint").all(deviceId) as Row[]
    ).map(toPushSubscription);
  }

  /** The subscriptions of the browsers still registered. */
  pushSubscriptions(): PushSubscriptionRecord[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM push_subscriptions p JOIN devices d ON d.id = p.device_id
           WHERE d.revoked_at IS NULL ORDER BY p.created_at, p.endpoint`,
        )
        .all() as Row[]
    ).map(toPushSubscription);
  }

  /** Forgets a subscription; with `deviceId`, only that browser's. */
  deletePushSubscription(endpoint: string, deviceId?: string): boolean {
    const res = deviceId
      ? this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?").run(endpoint, deviceId)
      : this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    return Number(res.changes) > 0;
  }

  // ---- events and notifications ----

  addEvent(e: MachineHookEvent): void {
    this.db.prepare("INSERT INTO events (at, data) VALUES (?, ?)").run(e.at, JSON.stringify(e));
  }

  recentEvents(limit = 200): MachineHookEvent[] {
    const rows = this.db.prepare("SELECT data FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as MachineHookEvent).reverse();
  }

  addNotification(n: GashoNotification): void {
    this.db
      .prepare("INSERT OR REPLACE INTO notifications (id, at, read, data) VALUES (?, ?, ?, ?)")
      .run(n.id, n.at, n.read ? 1 : 0, JSON.stringify(n));
  }

  recentNotifications(limit = 100): GashoNotification[] {
    const rows = this.db
      .prepare("SELECT data, read FROM notifications ORDER BY at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((r) => ({ ...(JSON.parse(String(r.data)) as GashoNotification), read: Number(r.read) === 1 }));
  }

  markRead(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(now - EVENT_TTL_MS);
    this.db.prepare("DELETE FROM notifications WHERE at < ?").run(now - NOTIFICATION_TTL_MS);
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(now - 24 * 3600_000);
  }

  close(): void {
    this.db.close();
  }
}
