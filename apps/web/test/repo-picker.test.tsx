import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { RepoPicker } from "@/components/repo-picker";

test("the repositories of a folder open on GitHub when they have one, and the others say they have none", async () => {
  const user = userEvent.setup();
  render(
    <RepoPicker
      repos={[
        { path: "/src/work/app", branch: "main", github: { owner: "acme", name: "app", url: "https://github.com/acme/app" } },
        { path: "/src/work/notes", branch: "draft" },
      ]}
    />,
  );

  await user.click(screen.getByRole("button", { name: "複数のリポジトリ…" }));
  const list = screen.getByRole("dialog");
  expect(within(list).getByText("リポジトリ（2）")).toBeTruthy();
  const app = within(list).getByRole("link", { name: /\/src\/work\/app/ });
  expect(app.getAttribute("href")).toBe("https://github.com/acme/app");
  expect(app.getAttribute("target")).toBe("_blank");
  expect(app.textContent).toContain("acme/app · main");

  // A repository without origin is listed, but not as a link.
  expect(within(list).getAllByRole("link")).toHaveLength(1);
  expect(within(list).getByText("/src/work/notes").closest("div")?.textContent).toContain("GitHub なし");
});
