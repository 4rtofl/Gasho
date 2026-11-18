// What the end-to-end tests of Gasho, and of GashoPlugins (from its gasho/ checkout), start and drive: a Gasho server
// of the test's own, fake or real gasho-daemons, and the fake gh, npm and claude. It does not import @playwright/test,
// which a test runner may load only once: each repository's tests build their fixtures on it (e2e/tests/fixtures.ts).
export { type BrowserCookie, checkoutVersion, type DaemonOptions, GashoHub, type HubOptions, RealDaemon, startHub } from "./hub.ts";
export { type Answer, commandResult, delay, FakeDaemon, type FakeDaemonOptions, fakeSession, textEntry, transcriptPage } from "./fake-daemon.ts";
export {
  type AgentRow,
  type ArgPattern,
  catalogAnswer,
  type ClaudeTable,
  type ControlAnswer,
  type FakeAnswer,
  type FakeCall,
  FakeCommand,
  type FakeTable,
  npmLatestAnswer,
} from "./fakes.ts";
export { GASHO_DIR } from "./process.ts";
export { HUB_PACKAGE, hubInstallAnswer, type HubService, type HubServiceOptions } from "./hub-service.ts";
export { addPlugin, catalogWith, copyTestPlugin, listedPlugin, type PluginRelease, pluginsDir, releasePlugin, TEST_PLUGINS, writePlugin } from "./plugins.ts";
