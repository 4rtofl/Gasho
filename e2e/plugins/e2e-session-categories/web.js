// A plugin for the end-to-end tests, written by hand as a plugin's build turns one into (no build): the SDK comes from
// what Gasho's screen shares (globalThis.__gasho). Its session list (P17) has one category for each worktree, whose
// "＋" starts a session there, and hides the tabs above a session: the sidebar then shows "新しいセッション", the
// categories' "＋", and the button that starts a session in the body of a worktree without one.
const sdk = globalThis.__gasho.modules["@gasho/plugin-sdk"];

export default sdk.definePlugin({
  sessionList: {
    hideSessionTabs: true,
    useCategories: (ctx) =>
      ctx.worktrees.map((w) => ({
        id: w.key,
        title: w.branch ?? w.path,
        launch: w.key,
        sessions: ctx.sessions.filter((s) => s.worktree === w.key).map((s) => ({ machine: s.machine.id, sessionId: s.session.sessionId })),
      })),
  },
});
