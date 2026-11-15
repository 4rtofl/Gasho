// The files Claude sent to the person (a tool call's `sent`, Claude Code's SendUserFile): where the browser reads
// the images and videos, what each file is called, and which of them are shown as they are.
import type { SentFile } from "@gasho/protocol";

/** Where the browser reads an image or a video that Claude sent in a session: the Gasho server gets it from the working server. */
export function mediaUrl(machine: string, sessionId: string, file: string): string {
  return `/media/${encodeURIComponent(machine)}/${encodeURIComponent(sessionId)}?path=${encodeURIComponent(file)}`;
}

/** The name of a file, from its path. */
export function fileName(file: string): string {
  return file.replace(/\/+$/, "").split("/").pop() || file;
}

/**
 * How the files of one call are shown: `shown`, the images and videos to show as they are (none when Claude asked
 * for files, `attach`); `listed`, the others by their names; `viewable`, the images and videos that the viewer goes
 * through (those listed too), in the order Claude sent them.
 */
export function sentFilesLayout(files: readonly SentFile[], attach: boolean): { shown: SentFile[]; listed: SentFile[]; viewable: SentFile[] } {
  const viewable = files.filter((f) => f.kind !== "file");
  const shown = attach ? [] : viewable;
  return { shown, listed: files.filter((f) => !shown.includes(f)), viewable };
}
