// The versions the settings screen lists: the Gasho server, the build of the screen, the plugin API, and each working
// server's gasho-daemon. The button that copies them writes the same rows, so that what is pasted says what is shown.
import type { LatestVersions, MachineInfo, ServerInfo } from "@gasho/protocol";
import { newerPublished, updateTo } from "./daemon-update.ts";
import { hubNewerPublished, hubUpdateTo, outOfDate } from "./server-update.ts";

export interface VersionRow {
  key: string;
  label: string;
  value: string;
  /**
   * Said beside the version: a clone's commit, the build the Gasho server serves when this page's is another,
   * gasho-daemon's plugin API, a working server being offline.
   */
  details: string[];
  /**
   * A newer version published (the row takes to the updates on the 端末 screen), and whether it can be updated to from
   * Gasho now, as the 端末 screen says (else that row says why not).
   */
  newer?: { version: string; updatable: boolean };
}

const UNKNOWN = "不明";

export function versionRows(o: {
  server: ServerInfo | undefined;
  machines: MachineInfo[];
  latest: LatestVersions | undefined;
  /** This page's build. */
  build: string;
}): VersionRow[] {
  const { server, latest } = o;
  const hubNewer = latest?.hub && hubNewerPublished(server, latest) ? { version: latest.hub, updatable: hubUpdateTo(server, latest) !== undefined } : undefined;
  return [
    {
      key: "hub",
      label: "Gasho サーバー（gasho-hub）",
      value: server?.version ?? UNKNOWN,
      details: server?.commit ? [`commit ${server.commit}`] : [],
      ...(hubNewer ? { newer: hubNewer } : {}),
    },
    {
      key: "web",
      label: "画面のビルド",
      value: o.build,
      details: server?.web && outOfDate(server, o.build) ? [`Gasho サーバーは ${server.web} を配信中`] : [],
    },
    { key: "plugin-api", label: "プラグインの API", value: server?.pluginApi ?? UNKNOWN, details: [] },
    ...o.machines.map((m): VersionRow => {
      const newer = latest?.daemon && newerPublished(m, latest) ? { version: latest.daemon, updatable: updateTo(m, latest) !== undefined } : undefined;
      return {
        key: `daemon:${m.id}`,
        label: `gasho-daemon（${m.name}）`,
        value: m.daemonVersion ?? UNKNOWN,
        details: [...(m.pluginApi ? [`プラグインの API ${m.pluginApi}`] : []), ...(m.connected ? [] : ["オフライン"])],
        ...(newer ? { newer } : {}),
      };
    }),
  ];
}

/** The rows as text to paste, one per line: "label: version（details）". */
export function versionsText(rows: VersionRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}${r.details.length > 0 ? `（${r.details.join("・")}）` : ""}`).join("\n");
}
