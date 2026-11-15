// The images and videos Claude sends to the person in a session (Claude Code's SendUserFile), served to browsers over
// HTTP: GET /media/<machine>/<session>?path=<the file's path on the working server>. The Gasho server asks the working
// server for the file part by part, as the browser reads it, and answers Range requests: a video then starts to play
// at once and can be sought, and Safari plays a video only from a server that answers them.
import type http from "node:http";
import path from "node:path";
import { type Hub, type MediaAnswer, MAX_MEDIA_PART } from "./hub.ts";

/** The bytes a Range header asks for. */
export type ByteRange = { start: number; end: number };

/**
 * The bytes a Range header asks for, of a file of `size` bytes ([start, end], end included): "unsatisfiable" when the
 * file has none of them, undefined when the whole file is to be sent (no Range, one that is not understood, or several
 * ranges, which a server may answer with the whole file).
 */
export function byteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  const m = header === undefined ? null : /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return undefined;
  const [, from = "", to = ""] = m;
  if (from === "" && to === "") return undefined;
  if (from === "") {
    // The last `to` bytes.
    const n = Number(to);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(from);
  const last = to === "" ? Number.MAX_SAFE_INTEGER : Number(to);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last) || last < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(last, size - 1) };
}

/** Whether an If-None-Match header names `etag` (or any). */
function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

function fail(res: http.ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(error);
}

/** Waits until the response takes more data, or is closed. */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * Answers GET (and HEAD) /media/<machine>/<session>?path=… for a registered browser: the image or video, whole or the
 * range asked for, read from the working server part by part. The working server reads only images and videos that the
 * session's conversation sent; the type it gives is the only one answered with.
 */
export async function serveMedia(hub: Hub, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }).end("method not allowed");
    return;
  }
  const segments = url.pathname.slice("/media/".length).split("/");
  let machine: string;
  let sessionId: string;
  try {
    if (segments.length !== 2) throw new Error("path");
    [machine = "", sessionId = ""] = segments.map(decodeURIComponent);
  } catch {
    return fail(res, 404, "not found");
  }
  const file = url.searchParams.get("path") ?? "";
  if (!machine || !file) return fail(res, 400, "パスの指定が正しくありません。");

  // What the file is now: the answer, and every part sent, is of that version of it.
  const stat = await hub.media(machine, sessionId, file, 0, 0);
  if ("status" in stat) return fail(res, stat.status, stat.error);
  const { size, mtime, mime } = stat.part;
  const etag = `"${size.toString(36)}-${mtime.toString(36)}"`;
  const headers: Record<string, string> = {
    "content-type": mime,
    "accept-ranges": "bytes",
    etag,
    "last-modified": new Date(mtime).toUTCString(),
    // The file can change under the same path (Claude sends it again): the browser asks each time, by its ETag.
    "cache-control": "private, no-cache",
    "x-content-type-options": "nosniff",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.posix.basename(file))}`,
  };
  // Opened on its own, an SVG runs no script and loads nothing.
  if (mime === "image/svg+xml") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (matches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, { etag, "cache-control": headers["cache-control"] ?? "" }).end();
    return;
  }
  // A Range with If-Range for another version of the file gets the whole file.
  const ifRange = req.headers["if-range"];
  const range = ifRange === undefined || ifRange === etag ? byteRange(req.headers.range, size) : undefined;
  if (range === "unsatisfiable") {
    res.writeHead(416, { "content-range": `bytes */${size}`, "content-type": "text/plain; charset=utf-8" }).end("range not satisfiable");
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    "content-length": String(end + 1 - start),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === "HEAD" || end < start) {
    res.end();
    return;
  }

  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const ask = (offset: number): Promise<MediaAnswer> => hub.media(machine, sessionId, file, offset, Math.min(MAX_MEDIA_PART, end + 1 - offset));
  let offset = start;
  // The next part is asked for while this one is written.
  let next = ask(offset);
  while (offset <= end) {
    const got = await next;
    if (closed) return;
    const want = Math.min(MAX_MEDIA_PART, end + 1 - offset);
    // The file changed (or went) meanwhile: the browser must not get parts of two versions.
    if ("status" in got || got.part.size !== size || got.part.mtime !== mtime || got.bytes.length !== want) {
      res.destroy();
      return;
    }
    offset += want;
    if (offset <= end) next = ask(offset);
    if (!res.write(got.bytes)) await drained(res);
    if (closed) return;
  }
  res.end();
}
