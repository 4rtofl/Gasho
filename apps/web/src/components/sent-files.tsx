// Files Claude sent to the person (Claude Code's SendUserFile), in the conversation: the images and videos as they
// are, the other files by their names. The images and videos are read from the working server through the Gasho
// server (GET /media/…) when they are shown, so they show what the files hold now. A picture opens larger in a viewer,
// which goes through the call's images and videos.
import { ChevronLeft, ChevronRight, Download, FileText, Film, ImageIcon, ImageOff, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { createContext, useContext, useEffect, useState, type KeyboardEvent } from "react";
import type { SentFile, SentFiles as Sent } from "@gasho/protocol";
import { fileName, mediaUrl, sentFilesLayout } from "@/lib/sent-files";
import { cn } from "@/lib/utils";

/** The session whose conversation is shown, to read its images and videos from. Absent where none are read (a sample). */
export interface MediaSource {
  machine: string;
  sessionId: string;
  /** Its working server is connected: only then can its files be read. */
  online: boolean;
}

export const SentFilesSource = createContext<MediaSource | undefined>(undefined);

/**
 * Where an image or a video goes: a slot as high before it has come as after, so that the conversation does not move
 * when it comes. One alone takes a large slot, several a grid of cells. In it, the picture keeps its proportions and is
 * never enlarged.
 */
const SLOT = "h-60 md:h-80";
const CELL = "h-32 justify-center rounded-lg bg-white/[0.03] md:h-40";
/** Behind a picture (and only there): squares that show where it is transparent. */
const CHECKERS = "bg-[image:repeating-conic-gradient(#8881_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]";
const MEDIA = "block min-w-0 max-h-full max-w-full rounded-lg border border-border/60";

/**
 * The files of one call: its images and videos (one alone is large, several are a grid), then the other files by
 * name, and Claude's caption. `error`: the call failed (its result says why).
 */
export function SentFiles({ sent, error }: { sent: Sent; error?: string }) {
  const source = useContext(SentFilesSource);
  const [viewing, setViewing] = useState<number>();
  const { shown, listed, viewable } = sentFilesLayout(sent.files, sent.attach === true);
  const url = (f: SentFile) => (source ? mediaUrl(source.machine, source.sessionId, f.path) : "");
  const canShow = source?.online === true;
  const open = (f: SentFile) => setViewing(viewable.indexOf(f));
  const images = shown.filter((f) => f.kind === "image");
  const videos = shown.filter((f) => f.kind === "video");
  return (
    <div role="group" aria-label="Claude が送ったファイル" className="space-y-2">
      {shown.length > 0 && !canShow && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageOff className="size-3.5 shrink-0" />
          {source ? "working server がオフラインのため、画像と動画を表示できません。" : "画像と動画は、セッションの画面で表示します。"}
        </p>
      )}
      {canShow && images.length === 1 && images[0] && <Picture file={images[0]} src={url(images[0])} slot={SLOT} onOpen={() => open(images[0]!)} />}
      {canShow && images.length > 1 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {images.map((f, i) => (
            <Picture key={i} file={f} src={url(f)} slot={CELL} cell onOpen={() => open(f)} />
          ))}
        </div>
      )}
      {canShow && videos.map((f, i) => <Video key={i} file={f} src={url(f)} />)}
      {(listed.length > 0 || (!canShow && shown.length > 0)) && (
        <div className="flex flex-wrap gap-1.5">
          {(canShow ? listed : sent.files).map((f, i) => (
            <FileChip key={i} file={f} onOpen={canShow && f.kind !== "file" ? () => open(f) : undefined} />
          ))}
        </div>
      )}
      {sent.caption && <p className="whitespace-pre-wrap break-words text-[length:calc(13px*var(--chat-scale,1))] leading-relaxed text-foreground/80">{sent.caption}</p>}
      {error && <p className="whitespace-pre-wrap break-words text-xs text-red-400">送れませんでした：{error}</p>}
      {viewing !== undefined && viewing >= 0 && source && (
        <Viewer files={viewable} index={viewing} url={url} onIndex={setViewing} onClose={() => setViewing(undefined)} />
      )}
    </div>
  );
}

/** Says that a file could not be shown: on a line, or in its cell of a grid. */
function Unavailable({ file, cell = "" }: { file: SentFile; cell?: string }) {
  return (
    <div
      title={file.path}
      className={cn(
        "flex gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground",
        cell ? cn(cell, "flex-col items-center text-center") : "items-center",
      )}
    >
      <ImageOff className="size-4 shrink-0" />
      <span className="min-w-0 break-words">
        <span className="font-medium text-foreground/80">{fileName(file.path)}</span>
        ：表示できません（ファイルが消えたか、移された可能性があります）
      </span>
    </div>
  );
}

/**
 * An image in its slot. The slot is the button, so that the picture can take the slot's height; pressed, it opens in
 * the viewer.
 */
function Picture({ file, src, slot, cell = false, onOpen }: { file: SentFile; src: string; slot: string; cell?: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <Unavailable file={file} cell={cell ? slot : ""} />;
  const name = fileName(file.path);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${name}（押すと大きく表示）`}
      className={cn("flex w-full items-center outline-none [&:focus-visible>img]:ring-2 [&:focus-visible>img]:ring-ring/60", slot)}
    >
      <img src={src} alt={name} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className={cn(MEDIA, CHECKERS, "cursor-zoom-in")} />
    </button>
  );
}

/**
 * A video in its slot, with the browser's own controls (full screen among them). Its first frame is shown before it
 * plays: Safari shows nothing until then without the start time in the address.
 */
function Video({ file, src }: { file: SentFile; src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <Unavailable file={file} />;
  return (
    <div className={cn("flex items-center", SLOT)}>
      <video
        src={`${src}#t=0.001`}
        controls
        playsInline
        preload="metadata"
        aria-label={fileName(file.path)}
        onError={() => setFailed(true)}
        className={cn(MEDIA, "bg-black")}
      />
    </div>
  );
}

/** A file by its name (its path on hover). An image or a video Claude offered as a file opens in the viewer. */
function FileChip({ file, onOpen }: { file: SentFile; onOpen?: () => void }) {
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "video" ? Film : FileText;
  const body = (
    <>
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{fileName(file.path)}</span>
    </>
  );
  const look = "inline-flex max-w-full items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1 text-xs";
  if (!onOpen) {
    return (
      <span title={file.path} className={look}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" title={`${file.path}（押すと表示）`} onClick={onOpen} className={cn(look, "hover:bg-white/[0.1] focus-visible:ring-2 focus-visible:ring-ring/50 outline-none")}>
      {body}
    </button>
  );
}

const VIEWER_BUTTON =
  "grid size-9 shrink-0 place-items-center rounded-full text-white/85 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60";

/**
 * The images and videos of a call, one at a time, over the whole screen. A picture fits the screen; pressed, it is
 * shown at its own size, to scroll around in. ← and → (or the buttons at the sides) go to the others.
 */
function Viewer({
  files,
  index,
  url,
  onIndex,
  onClose,
}: {
  files: SentFile[];
  index: number;
  url: (f: SentFile) => string;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  const file = files[index];
  useEffect(() => {
    setActual(false);
    setFailed(false);
  }, [index]);
  if (!file) return null;
  const name = fileName(file.path);
  const src = url(file);
  const many = files.length > 1;
  const go = (step: number) => onIndex((index + step + files.length) % files.length);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!many || e.altKey || e.ctrlKey || e.metaKey) return;
    // Not while a video's own controls have the keys.
    if (e.target instanceof HTMLVideoElement) return;
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
    else return;
    e.preventDefault();
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/90 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-[91] flex flex-col text-white outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
          style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <div className="flex shrink-0 items-center gap-1 px-2 py-1.5 sm:px-3">
            <Dialog.Title className="min-w-0 flex-1 truncate px-1 text-sm font-medium" title={file.path}>
              {name}
            </Dialog.Title>
            {many && (
              <span className="shrink-0 px-1 text-xs tabular-nums text-white/60">
                {index + 1} / {files.length}
              </span>
            )}
            <a href={src} download={name} aria-label="保存" title="保存" className={VIEWER_BUTTON}>
              <Download className="size-4.5" />
            </a>
            <Dialog.Close aria-label="閉じる" title="閉じる（Esc）" className={VIEWER_BUTTON}>
              <X className="size-5" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Claude が送った画像と動画</Dialog.Description>
          <div
            className="relative min-h-0 flex-1 overflow-auto"
            // A press beside the picture closes the viewer, as on the dimmed part of a dialog.
            onClick={(e) => e.target === e.currentTarget && onClose()}
          >
            {failed ? (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/70">
                表示できません（ファイルが消えたか、移された可能性があります）
              </div>
            ) : file.kind === "video" ? (
              <video
                key={src}
                src={src}
                controls
                autoPlay
                playsInline
                onError={() => setFailed(true)}
                className="absolute inset-0 m-auto max-h-full max-w-full"
              />
            ) : actual ? (
              <div className="flex min-h-full w-max min-w-full items-center justify-center p-2" onClick={(e) => e.target === e.currentTarget && onClose()}>
                <img src={src} alt={name} onClick={() => setActual(false)} onError={() => setFailed(true)} className="max-w-none cursor-zoom-out" />
              </div>
            ) : (
              <img
                key={src}
                src={src}
                alt={name}
                onClick={() => setActual(true)}
                onError={() => setFailed(true)}
                className="absolute inset-0 m-auto max-h-full max-w-full cursor-zoom-in object-contain p-2"
              />
            )}
            {many && (
              <>
                <button type="button" aria-label="前へ" title="前へ（←）" onClick={() => go(-1)} className={cn(VIEWER_BUTTON, "fixed top-1/2 left-2 -translate-y-1/2 bg-black/40")}>
                  <ChevronLeft className="size-5" />
                </button>
                <button type="button" aria-label="次へ" title="次へ（→）" onClick={() => go(1)} className={cn(VIEWER_BUTTON, "fixed top-1/2 right-2 -translate-y-1/2 bg-black/40")}>
                  <ChevronRight className="size-5" />
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
