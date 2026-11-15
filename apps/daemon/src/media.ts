// The files Claude sends to the person with Claude Code's SendUserFile tool, for the conversation on the Gasho screen:
// what each is shown as, and the parts of the images and videos that the Gasho server asks for as a browser reads
// them. The files are read where they are on the working server, when they are shown. Only the images and videos a
// session's conversation sent are read (TranscriptMeta.sentFiles); the Daemon checks that before reading.
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaPart, SentFile, SentFileKind } from "@gasho/protocol";

/** The tool, and the most files one call names that are shown (Claude sends a few at a time). */
export const SEND_FILE_TOOL = "SendUserFile";
const MAX_FILES_PER_CALL = 50;
const MAX_PATH = 4096;

/** The most a part of a file can hold: about 1.4 MB as base64, well within a WebSocket message (16 MB). */
export const MAX_MEDIA_PART = 1024 * 1024;

/** Images and videos, by the extension of their names, and the type a browser is told. SVG is shown as an image too (it runs no script there). */
const MEDIA_TYPES: Record<string, { kind: "image" | "video"; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".avif": { kind: "image", mime: "image/avif" },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".svg": { kind: "image", mime: "image/svg+xml" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".m4v": { kind: "video", mime: "video/mp4" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".ogv": { kind: "video", mime: "video/ogg" },
};

function mediaType(file: string): { kind: "image" | "video"; mime: string } | undefined {
  return MEDIA_TYPES[path.extname(file).toLowerCase()];
}

/** What a file is shown as, by the extension of its name. */
export function sentFileKind(file: string): SentFileKind {
  return mediaType(file)?.kind ?? "file";
}

/**
 * The files a call of SendUserFile names (`files`, from `cwd` when not absolute), or undefined when its input is not
 * that shape (an older or newer Claude Code): the call is then shown as a tool call.
 */
export function sentFiles(input: unknown, cwd: string | undefined): SentFile[] | undefined {
  const files = input && typeof input === "object" ? (input as { files?: unknown }).files : undefined;
  if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === "string")) return undefined;
  return (files as string[]).slice(0, MAX_FILES_PER_CALL).map((given) => {
    const p = given.trim();
    const abs = path.isAbsolute(p) ? path.normalize(p) : cwd && path.isAbsolute(cwd) && p ? path.resolve(cwd, p) : undefined;
    if (!abs || abs.length > MAX_PATH || abs.includes("\0")) return { path: given, kind: "file" as const };
    return { path: abs, kind: sentFileKind(abs) };
  });
}

/** Why a file Claude sent cannot be read (`notFound`: it is not there), for the person who wants to see it. */
export type MediaFailed = { error: string; notFound?: boolean };

/**
 * `length` bytes (at most MAX_MEDIA_PART; 0 for only what the file is) from `offset` of the image or video `file`, an
 * absolute path. Fewer at the end of the file; none from beyond it.
 */
export async function readMediaPart(file: string, offset: number, length: number): Promise<MediaPart | MediaFailed> {
  if (!path.isAbsolute(file)) return { error: "パスの指定が正しくありません。" };
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_MEDIA_PART) {
    return { error: "読む範囲の指定が正しくありません。" };
  }
  const type = mediaType(file);
  if (!type) return { error: "画像か動画のファイルではありません。" };
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(file, "r");
  } catch (e) {
    return failed(e);
  }
  try {
    const st = await fh.stat();
    // A FIFO or a device would block, or never end.
    if (!st.isFile()) return { error: "ふつうのファイルではありません。" };
    const want = Math.max(0, Math.min(length, st.size - offset));
    const buf = Buffer.alloc(want);
    let n = 0;
    while (n < want) {
      const { bytesRead } = await fh.read(buf, n, want - n, offset + n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return { mime: type.mime, size: st.size, mtime: Math.round(st.mtimeMs), offset, data: buf.subarray(0, n).toString("base64") };
  } catch (e) {
    return failed(e);
  } finally {
    await fh.close();
  }
}

function failed(e: unknown): MediaFailed {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return { error: "ファイルがありません（消されたか、移された）。", notFound: true };
  if (code === "EACCES" || code === "EPERM") return { error: "ファイルを読む権限がありません。" };
  if (code === "EISDIR") return { error: "フォルダーです。" };
  return { error: `ファイルを読めませんでした：${e instanceof Error ? e.message : String(e)}` };
}
