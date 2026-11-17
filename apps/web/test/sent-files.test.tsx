import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SentFiles as Sent } from "@gasho/protocol";
import { expect, test } from "vitest";
import { type MediaSource, SentFiles, SentFilesSource } from "@/components/sent-files";

const online: MediaSource = { machine: "m 1", sessionId: "s1", online: true };

function show(sent: Sent, source: MediaSource | undefined = online, error?: string) {
  render(
    <SentFilesSource.Provider value={source}>
      <SentFiles sent={sent} error={error} />
    </SentFilesSource.Provider>,
  );
}

const shot = { path: "/repo/shot.png", kind: "image" } as const;
const movie = { path: "/repo/demo.mp4", kind: "video" } as const;
const plan = { path: "/repo/plan.png", kind: "image" } as const;
const notes = { path: "/repo/notes.md", kind: "file" } as const;

test("images are read from the session's working server, and open in a viewer that goes through the images and videos", async () => {
  const user = userEvent.setup();
  show({ files: [shot, notes, movie, plan], caption: "画面です" });

  const picture = screen.getByRole<HTMLImageElement>("img", { name: "shot.png" });
  expect(picture.getAttribute("src")).toBe("/media/m%201/s1?path=%2Frepo%2Fshot.png");
  expect(screen.getByLabelText("demo.mp4").getAttribute("src")).toBe("/media/m%201/s1?path=%2Frepo%2Fdemo.mp4#t=0.001");
  // A file that is not an image or a video is listed by its name, not opened.
  expect(screen.getByText("notes.md").closest("button")).toBeNull();
  expect(screen.getByText("画面です")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "shot.png" }));
  const viewer = screen.getByRole("dialog", { name: "shot.png" });
  expect(within(viewer).getByText("1 / 3")).toBeTruthy();
  expect(within(viewer).getByRole("link", { name: "保存" }).getAttribute("download")).toBe("shot.png");

  // ← and → go round the images and videos in the order Claude sent them.
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("dialog", { name: "plan.png" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "次へ" }));
  await user.click(screen.getByRole("button", { name: "次へ" }));
  expect(screen.getByRole("dialog", { name: "demo.mp4" })).toBeTruthy();
  expect(screen.getByText("2 / 3")).toBeTruthy();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an image that cannot be read says so in its place", () => {
  show({ files: [shot] });
  fireEvent.error(screen.getByRole("img", { name: "shot.png" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/表示できません/).closest("[title]")?.getAttribute("title")).toBe("/repo/shot.png");
});

test("while the working server is offline, nothing is read and the files are listed by their names", () => {
  show({ files: [shot, notes] }, { ...online, online: false });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("working server がオフラインのため、画像と動画を表示できません。")).toBeTruthy();
  expect(screen.getByText("shot.png")).toBeTruthy();
  expect(screen.getByText("notes.md")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test("images Claude offered as files are listed by name and still open in the viewer, and a failed call says why", async () => {
  const user = userEvent.setup();
  show({ files: [shot, notes], attach: true }, online, "ファイルがありません");
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("送れませんでした：ファイルがありません")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "shot.png" }));
  expect(screen.getByRole("dialog", { name: "shot.png" })).toBeTruthy();
});
