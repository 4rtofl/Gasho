// Gasho's Service Worker: only for Web Push (docs/iphone.md). It shows what the Gasho server pushes and opens the
// session when the notification is tapped. It caches no files, so the page is always the build the server serves.
/* eslint-env serviceworker */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Gasho";
  const shown = self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    icon: "/icons/icon-192.png",
    data: { url: typeof data.url === "string" ? data.url : "/" },
  });
  const badge =
    typeof data.badge === "number" && "setAppBadge" in self.navigator
      ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {})
      : Promise.resolve();
  // iOS stops sending pushes to a worker that does not show one for each, so it is always shown.
  event.waitUntil(Promise.all([shown, badge]));
});

// The session a tapped notification asks for, kept a short while for the page to ask after (gasho.pending): when
// the app was closed, iOS starts it at start_url and openWindow may not take it there, and a page that was stopped
// may miss the message. Kept in Cache Storage, as the worker may be stopped meanwhile.
const PENDING_CACHE = "gasho-pending-open";
const PENDING_KEY = "/__gasho/pending-open";
const PENDING_TTL_MS = 60_000;

async function savePending(url) {
  const cache = await caches.open(PENDING_CACHE);
  await cache.put(PENDING_KEY, new Response(JSON.stringify({ url, at: Date.now() })));
}

/** The URL waiting to be opened, forgotten once taken. */
async function takePending() {
  const cache = await caches.open(PENDING_CACHE);
  const res = await cache.match(PENDING_KEY);
  if (!res) return undefined;
  await cache.delete(PENDING_KEY);
  try {
    const { url, at } = await res.json();
    return typeof url === "string" && typeof at === "number" && Date.now() - at < PENDING_TTL_MS ? url : undefined;
  } catch {
    return undefined;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      await savePending(url).catch(() => {});
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // The page goes there itself (lib/push.ts): its state is kept.
        await open.focus().catch(() => {});
        open.postMessage({ type: "gasho.open", url });
        return;
      }
      await self.clients.openWindow(url).catch(() => {});
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  const source = event.source;
  if (type === "gasho.pending") {
    // A page started or came back: it goes to the session a notification asked for, if one waits.
    event.waitUntil(
      takePending()
        .then((url) => {
          if (url && source) source.postMessage({ type: "gasho.open", url });
        })
        .catch(() => {}),
    );
  } else if (type === "gasho.opened") {
    // The page went there from the message: nothing waits any more.
    event.waitUntil(caches.delete(PENDING_CACHE).catch(() => {}));
  }
});
