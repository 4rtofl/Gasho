import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The tests that draw the screen's parts (test/*.test.tsx). The tests of its plain functions (test/*.test.ts) run with
// node --test, as the Gasho server's and gasho-daemon's do.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["test/**/*.test.tsx"],
    environment: "happy-dom",
    environmentOptions: { happyDOM: { url: "http://gasho.test/" } },
    setupFiles: ["test/setup.ts"],
    // A test that clicks and types through user-event took 2 s on a busy machine: 5 s (the default) leaves little room.
    testTimeout: 30_000,
  },
});
