// The versions the settings screen lists: the Gasho server, the build of the screen, the plugin API, and each working
// server's gasho-daemon. The button that copies them writes the same rows, so that what is pasted says what is shown.
import type { LatestVersions, MachineInfo, ServerInfo } from "@gasho/protocol";
import { newerPublished } from "./daemon-update.ts";
import { hubNewerPublished } from "./server-update.ts";

export interface VersionRow {
  key: string;
  label: string;
  value: string;
  /** Said beside the version: a clone's commit, gasho-daemon's plugin API, a working server being offline. */
  details: string[];
  /** A newer version published (the row offers the updates on the 端末 screen). */
  newer?: string;
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
  const hubNewer = hubNewerPublished(server, latest) ? latest?.hub : undefined;
  return [
    {
      key: "hub",
      label: "Gasho サーバー（gasho-hub）",
      value: server?.version ?? UNKNOWN,
      details: server?.commit ? [`commit ${server.commit}`] : [],
      ...(hubNewer ? { newer: hubNewer } : {}),
    },
    { key: "web", label: "画面のビルド", value: o.build, details: [] },
    { key: "plugin-api", label: "プラグインの API", value: server?.pluginApi ?? UNKNOWN, details: [] },
    ...o.machines.map((m): VersionRow => {
      const newer = newerPublished(m, latest) ? latest?.daemon : undefined;
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
