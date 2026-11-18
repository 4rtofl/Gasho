// Gasho's fixtures: each test gets a Gasho server of its own (hub), and a page whose browser is registered with it (the
// registration cookie). Registering with a code on the screen is a scenario of its own.
import { test as base } from "@playwright/test";
import { type GashoHub, startHub } from "../harness/index.ts";
import type { HubOptions } from "../harness/hub.ts";

export const test = base.extend<{ hub: GashoHub; hubOptions: HubOptions }>({
  hubOptions: [{}, { option: true }],
  hub: async ({ hubOptions }, use, testInfo) => {
    const hub = await startHub(hubOptions);
    await use(hub);
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach("gasho-logs", { body: hub.logs(), contentType: "text/plain" });
    await hub.stop();
  },
  baseURL: async ({ hub }, use) => use(hub.url),
  context: async ({ context, hub }, use) => {
    await context.addCookies([await hub.browserCookie()]);
    await use(context);
  },
});

export { expect } from "@playwright/test";
