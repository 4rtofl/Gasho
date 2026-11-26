import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { OutsideSessions } from "@/components/outside-sessions";
import { worktreesByLastUse } from "@/lib/sessions";
import { machine, session } from "./hub";

const app = { path: "/src/app", repo: "/src/app", branch: "main" };
const lib = { path: "/src/lib", repo: "/src/lib", branch: "main" };
const repos = [app, lib].map((w) => ({ path: w.path, worktrees: [{ path: w.path, branch: "main" }] }));

/** The worktrees of a working server whose conversations open outside Gasho are these, `<folder>:<session>`. */
function worktrees(...open: string[]) {
  const sessions = open.map((o) => {
    const [folder, id] = o.split(":") as [string, string];
    const w = folder === "app" ? app : lib;
    return session(id, { cwd: w.path, worktree: w, managed: undefined, pid: 100 });
  });
  const list = worktreesByLastUse([{ ...machine("mac", sessions), repos }]);
  const of = (path: string) => list.find((w) => w.path === path)!;
  return { app: of(app.path), lib: of(lib.path) };
}

test("× closes the banner while only the conversations open then are open, and another one opening shows it again", async () => {
  const user = userEvent.setup();
  const banner = (w: ReturnType<typeof worktrees>) => (
    <>
      <OutsideSessions worktree={w.app} />
      <OutsideSessions worktree={w.lib} />
    </>
  );
  const { rerender } = render(banner(worktrees("app:o1", "app:o2", "lib:x")));
  await user.click(screen.getAllByRole("button", { name: "閉じる" })[0]!);
  // The other worktree's banner stays.
  expect(screen.getAllByText(/Gasho の外で/).map((p) => p.textContent)).toEqual(["Gasho の外で 1 件の会話が開いています"]);

  rerender(banner(worktrees("app:o2", "lib:x")));
  expect(screen.getAllByText(/Gasho の外で/)).toHaveLength(1);

  rerender(banner(worktrees("app:o2", "app:o3", "lib:x")));
  expect(screen.getAllByText(/Gasho の外で/).map((p) => p.textContent)).toEqual([
    "Gasho の外で 2 件の会話が開いています",
    "Gasho の外で 1 件の会話が開いています",
  ]);
});
