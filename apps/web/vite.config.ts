import { randomUUID } from "node:crypto";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const hub = process.env.GASHO_HUB_DEV ?? "http://127.0.0.1:7740";

/**
 * The build of the screen: GASHO_WEB_BUILD (the Gasho server's package builds it as hub-<version>), or a new one for
 * each build. It goes into the screen and into build.json beside it, which the Gasho server reads and tells pages: a
 * page of another build is out of date and reloads (lib/server-update.ts). "dev" under the dev server.
 */
const build = process.env.GASHO_WEB_BUILD || `local-${randomUUID().slice(0, 8)}`;

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "gasho-build",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ build })}\n` });
      },
    },
  ],
  define: { __GASHO_WEB_BUILD__: JSON.stringify(command === "serve" ? "dev" : build) },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    // During development the UI is served by Vite; WebSocket traffic goes to gasho-hub.
    proxy: {
      "/ws": { target: hub, ws: true },
      "/api": { target: hub },
      // The plugins' files (docs/plugins.md).
      "/plugins": { target: hub },
      // Images and videos Claude sent in a session.
      "/media": { target: hub },
    },
  },
}));
