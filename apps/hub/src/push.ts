// Web Push to the browsers that asked for it (docs/iphone.md): the VAPID keys (RFC 8292), the encryption of the
// message (RFC 8291, aes128gcm), and the sending, with node:crypto and fetch only.
import crypto from "node:crypto";
import type { GashoNotification, NotificationKind, PushInfo, PushPayload, PushSubscriptionInfo } from "@gasho/protocol";
import type { Store } from "./store.ts";

/** What the push services are told about who sends (VAPID `sub`): a URL of the project, no personal contact. */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/4rtoflow/Gasho";
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["done", "permission", "idle", "error"];
/** How long a push service keeps a message for a phone that is off (s). */
const TTL_S = 24 * 3600;
const SEND_TIMEOUT_MS = 15_000;
/** Subscriptions kept per browser: a browser has one per Service Worker, so more are left over ones. */
const MAX_PER_DEVICE = 5;
const MAX_ENDPOINT = 1024;
const VAPID_KEY = "vapid";

/** The lock screen's text for each kind (with the session's name as the title). */
const KIND_TEXT: Record<NotificationKind, string> = {
  done: "応答が終わりました",
  permission: "確認を待っています",
  idle: "入力を待っています",
  error: "エラーで止まりました",
};

const b64url = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

export interface VapidKeys {
  /** The uncompressed P-256 point (65 bytes), base64url: browsers subscribe with it. */
  publicKey: string;
  /** The private key as a JWK (d, x, y). */
  privateJwk: crypto.JsonWebKey;
}

export function newVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" });
  return { publicKey: rawPublicKey(privateJwk), privateJwk };
}

function rawPublicKey(jwk: crypto.JsonWebKey): string {
  return b64url(Buffer.concat([Buffer.from([4]), fromB64url(String(jwk.x)), fromB64url(String(jwk.y))]));
}

/** The VAPID keys in the database, made and kept the first time. */
export function vapidKeysOf(store: Store): VapidKeys {
  const saved = store.getMeta(VAPID_KEY);
  if (saved) {
    try {
      const jwk = JSON.parse(saved) as crypto.JsonWebKey;
      crypto.createPrivateKey({ key: jwk, format: "jwk" });
      return { publicKey: rawPublicKey(jwk), privateJwk: jwk };
    } catch {
      // made again below: the subscriptions made with the old key stop working, and the browsers subscribe again
    }
  }
  const keys = newVapidKeys();
  store.setMeta(VAPID_KEY, JSON.stringify(keys.privateJwk));
  return keys;
}

/** The Authorization header for a push service (RFC 8292): a JWT signed with the VAPID key, and the public key. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12 hours, as the push services accept at most 24.
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${body}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts a message for a subscription (RFC 8291, Content-Encoding aes128gcm, one record). `salt` and `ephemeral`
 * are for tests: new ones are made otherwise.
 */
export function encryptPayload(
  plaintext: Buffer,
  sub: { p256dh: string; auth: string },
  opts: { salt?: Buffer; ephemeral?: crypto.ECDH } = {},
): Buffer {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  const ecdh = opts.ephemeral ?? crypto.createECDH("prime256v1");
  if (!opts.ephemeral) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with the delimiter 2, without padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** A subscription a browser sent, checked; undefined when it is not one. */
export function checkSubscription(v: unknown): PushSubscriptionInfo | undefined {
  const s = v as Partial<PushSubscriptionInfo> | undefined;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > MAX_ENDPOINT) return undefined;
  try {
    if (new URL(s.endpoint).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return undefined;
  const point = fromB64url(p256dh);
  if (point.length !== 65 || point[0] !== 4 || fromB64url(auth).length !== 16) return undefined;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export function checkKinds(v: unknown): NotificationKind[] {
  return Array.isArray(v) ? NOTIFICATION_KINDS.filter((k) => v.includes(k)) : [];
}

/** The fetch the sender posts with (tests give their own). */
export type PushFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface PushSenderOptions {
  store: Store;
  /** VAPID `sub`: GASHO_VAPID_SUBJECT, or DEFAULT_VAPID_SUBJECT. */
  subject?: string;
  fetch?: PushFetch;
  log?: (s: string) => void;
}

/** What a notification says on the lock screen: the session's name and what happened, nothing of the conversation. */
export function pushPayloadOf(n: GashoNotification, label: string, badge: number): PushPayload {
  return {
    title: label,
    body: KIND_TEXT[n.kind],
    kind: n.kind,
    tag: `${n.machine}/${n.sessionId}`,
    url: `/#/s/${encodeURIComponent(n.machine)}/${encodeURIComponent(n.sessionId)}`,
    badge,
  };
}

/** Keeps the browsers' subscriptions and sends them notifications. */
export class PushSender {
  private store: Store;
  private keys: VapidKeys;
  private subject: string;
  private fetch: PushFetch;
  private log: (s: string) => void;

  constructor(opts: PushSenderOptions) {
    this.store = opts.store;
    this.keys = vapidKeysOf(opts.store);
    this.subject = opts.subject || DEFAULT_VAPID_SUBJECT;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.log = opts.log ?? ((s) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`));
  }

  info(deviceId: string): PushInfo {
    return {
      publicKey: this.keys.publicKey,
      subscriptions: this.store.pushSubscriptionsOf(deviceId).map((s) => ({ endpoint: s.endpoint, kinds: s.kinds })),
    };
  }

  /** Keeps a browser's subscription (false when it is not one), and only its newest few. */
  subscribe(deviceId: string, subscription: unknown, kinds: unknown): boolean {
    const sub = checkSubscription(subscription);
    if (!sub) return false;
    this.store.savePushSubscription({ endpoint: sub.endpoint, deviceId, ...sub.keys, kinds: checkKinds(kinds) });
    const all = this.store.pushSubscriptionsOf(deviceId);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_PER_DEVICE))) {
      if (old.endpoint !== sub.endpoint) this.store.deletePushSubscription(old.endpoint);
    }
    return true;
  }

  unsubscribe(deviceId: string, endpoint: unknown): void {
    if (typeof endpoint === "string") this.store.deletePushSubscription(endpoint, deviceId);
  }

  /**
   * Sends a notification to every subscription that asked for its kind, but not to browsers `skip` names (one of their
   * pages is on screen). A subscription the push service no longer knows (404, 410) is forgotten.
   */
  async notify(n: GashoNotification, label: string, badge: number, skip: (deviceId: string) => boolean = () => false): Promise<void> {
    const subs = this.store.pushSubscriptions().filter((s) => s.kinds.includes(n.kind) && !skip(s.deviceId));
    if (subs.length === 0) return;
    const payload = Buffer.from(JSON.stringify(pushPayloadOf(n, label, badge)));
    await Promise.all(subs.map((s) => this.sendTo(s, payload)));
  }

  private async sendTo(s: { endpoint: string; p256dh: string; auth: string }, payload: Buffer): Promise<void> {
    let host = s.endpoint;
    try {
      host = new URL(s.endpoint).host;
      const res = await this.fetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(s.endpoint, this.keys, this.subject),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_S),
          urgency: "high",
        },
        body: encryptPayload(payload, s),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) {
        this.store.deletePushSubscription(s.endpoint);
        this.log(`web push: ${host} no longer knows a subscription (${res.status}); forgot it`);
      } else if (res.status < 200 || res.status >= 300) {
        const text = (await res.text().catch(() => "")).slice(0, 200);
        this.log(`web push: ${host} answered ${res.status} ${text}`);
      }
    } catch (e) {
      this.log(`web push: could not send to ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
