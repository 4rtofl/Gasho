// The first version of a plugin that the test replaces while the screen is open (hot reload).
const { modules } = globalThis.__gasho;
const h = modules.react.createElement;
const sdk = modules["@gasho/plugin-sdk"];
const Dot = (props) => h("svg", { viewBox: "0 0 24 24", fill: "currentColor", ...props }, h("circle", { cx: 12, cy: 12, r: 6 }));

export default sdk.definePlugin({
  sidebar: [{ id: "page", label: "E2E 版 1", icon: Dot, page: { id: "page" } }],
  pages: { page: () => h(sdk.Page, { title: "E2E 入れ替え" }, "1 つめの版") },
});
