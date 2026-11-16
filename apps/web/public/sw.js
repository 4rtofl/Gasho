// Gasho's Service Worker: only for Web Push (docs/iphone.md). It shows what the Gasho server pushes and opens the
// session when the notification is tapped. It keeps no files, so the page is always the build the server serves.
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // The page goes there itself (lib/push.ts): its state is kept.
        await open.focus().catch(() => {});
        open.postMessage({ type: "gasho.open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
