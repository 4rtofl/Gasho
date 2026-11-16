// Web Push on this browser (docs/iphone.md): the Service Worker (public/sw.js), the subscription the Gasho server
// sends to, and the app icon's badge.
import { useEffect, useState } from "react";
import type { MachineInfo, NotificationKind, PushInfo } from "@gasho/protocol";
import { getAppState, sendToHub, subscribeAppState } from "./store";

export const NOTIFICATION_KINDS: { kind: NotificationKind; label: string; note: string }[] = [
  { kind: "done", label: "完了", note: "Claude が応答を終えたとき" },
  { kind: "permission", label: "確認待ち", note: "権限の確認、質問、計画の承認を待っているとき" },
  { kind: "idle", label: "入力待ち", note: "応答のあと、しばらく入力がないとき" },
  { kind: "error", label: "エラー", note: "エラーで止まったとき" },
];
/** The kinds turned on when notifications are turned on: "入力待ち" mostly follows "完了". */
export const DEFAULT_KINDS: NotificationKind[] = ["done", "permission", "error"];

const SW_URL = "/sw.js";

/** Web Push works here: a secure context (HTTPS or localhost) with a Service Worker and the Push API. */
export function pushSupported(): boolean {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** An iPhone or iPad's Safari, not the Home Screen app: Web Push works only in the app. */
export function iosOutsideApp(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

/**
 * Registers the Service Worker, opens the session a tapped notification asks for, and keeps the app icon's badge.
 * Called once when the page starts.
 */
export function startPush(): void {
  watchBadge();
  if (!pushSupported()) return;
  navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" }).catch((e: unknown) => console.warn("gasho: service worker", e));
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as { type?: string; url?: string } | undefined;
    if (d?.type !== "gasho.open" || typeof d.url !== "string") return;
    try {
      const url = new URL(d.url, location.href);
      if (url.origin === location.origin) location.hash = url.hash || "#/";
    } catch {
      // not a page of Gasho
    }
  });
  // A subscription the Gasho server forgot (another key, or the push service said it was gone) is made again only
  // from the settings: subscribing needs a tap on iOS.
}

/** Sessions waiting for a confirmation, as the home screen counts them. */
export function waitingCount(machines: MachineInfo[]): number {
  let n = 0;
  for (const m of machines) {
    if (!m.connected) continue;
    for (const s of m.sessions) if (s.managed && s.status === "waiting") n++;
  }
  return n;
}

let badgeShown: number | undefined;

/** The app icon's badge (Badging API): how many sessions wait for a confirmation, while the page runs. */
function watchBadge(): void {
  if (!("setAppBadge" in navigator)) return;
  const show = () => {
    const s = getAppState();
    // Unknown until the first snapshot: kept as the last push set it.
    if (!s.synced) return;
    const n = waitingCount(s.machines);
    if (n === badgeShown) return;
    badgeShown = n;
    (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  };
  subscribeAppState(show);
  show();
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration(SW_URL)) ?? (await navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" }));
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/** This browser's subscription now, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Turns notifications on for `kinds`, or changes the kinds. Must run from a tap: iOS asks for the permission only
 * then. Resolves with why it could not, or undefined.
 */
export async function enablePush(push: PushInfo, kinds: NotificationKind[]): Promise<string | undefined> {
  if (!pushSupported()) return "このブラウザでは通知を使えません。";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return "通知が許可されていません。端末の設定で、Gasho の通知を許可してください。";
  try {
    const reg = await registration();
    const key = keyBytes(push.publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Made with another key (the Gasho server's database was made again): it cannot be sent to.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return "購読の情報を読めませんでした。";
    const sent = sendToHub({ type: "push.subscribe", subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, kinds });
    return sent ? undefined : "Gasho サーバーにつながっていません。";
  } catch (e) {
    return `通知を有効にできませんでした：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Turns notifications off on this browser. */
export async function disablePush(): Promise<string | undefined> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return undefined;
  const sent = sendToHub({ type: "push.unsubscribe", endpoint: sub.endpoint });
  if (!sent) return "Gasho サーバーにつながっていません。";
  await sub.unsubscribe().catch(() => false);
  return undefined;
}

/** The endpoint of this browser's subscription (undefined: none), read again whenever the Gasho server's list changes. */
export function useSubscriptionEndpoint(push: PushInfo | undefined): string | undefined | null {
  // null while it is being read.
  const [endpoint, setEndpoint] = useState<string | undefined | null>(null);
  useEffect(() => {
    let live = true;
    currentSubscription()
      .then((s) => live && setEndpoint(s?.endpoint))
      .catch(() => live && setEndpoint(undefined));
    return () => {
      live = false;
    };
  }, [push]);
  return endpoint;
}
