// The frame of a session's panel (the branch graph, the files, a plugin's panel), and of a plugin's page's panel (P19).
// On a computer it sits at the right of the session (or the page) and closes with its × button or Esc; on a phone it
// takes the screen, and its heading (a link back, the title, the buttons) goes into the screen's top bar (see
// PanelBarContext), so there is one bar, not two.
import { ArrowLeft, X } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo, SessionRepo } from "@gasho/protocol";
import { closesPanel } from "@/lib/text-input";
import { cn } from "@/lib/utils";

/**
 * On a phone, the place in the screen's top bar for the heading of the panel that takes the screen (App). Without it
 * the panel keeps its heading itself.
 */
export const PanelBarContext = createContext<HTMLElement | null>(null);

export function SidePanel({
  title,
  subtitle,
  actions,
  docked,
  onClose,
  backLabel = "セッションに戻る",
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Beside the session (a computer), rather than in its place (a phone). */
  docked: boolean;
  onClose: () => void;
  /** The link back on a phone: to the session, or to the page a page's panel is of. */
  backLabel?: string;
  children: ReactNode;
}) {
  const bar = useContext(PanelBarContext);
  const back = (
    <button
      type="button"
      onClick={onClose}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      {backLabel}
    </button>
  );
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      className="flex h-full min-h-0 flex-col"
      onKeyDown={(e) => {
        if (docked && closesPanel(e)) onClose();
      }}
    >
      {!docked && bar ? (
        createPortal(
          <>
            <button
              type="button"
              onClick={onClose}
              aria-label={backLabel}
              title={backLabel}
              className="-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-surface-raised hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
            </button>
            {/* At least a few characters of the title stay; buttons that do not fit beside it scroll sideways. */}
            <div className="min-w-16 flex-1">
              <h1 className="truncate text-sm leading-tight font-semibold">{title}</h1>
              {subtitle && <p className="truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="scrollbar-none flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap *:shrink-0">{actions}</div>}
          </>,
          bar,
        )
      ) : (
        <header className="shrink-0 space-y-2 border-b border-border px-4 py-3">
          {!docked && back}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold tracking-tight">{title}</h2>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
            {docked && (
              <button
                type="button"
                onClick={onClose}
                aria-label="閉じる"
                title="閉じる（Esc）"
                className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface-raised hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </header>
      )}
      {/* A container, so what is inside fits the panel's width rather than the screen's. relative: an absolutely
          placed element of a panel (a plugin's sr-only text) stays in here, rather than making the page longer (see
          Transcript). */}
      <div className="@container relative min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
    </section>
  );
}

/** A small bordered button in a panel's header (reload, open on GitHub). */
export const PANEL_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover disabled:opacity-50";

/**
 * The repository a panel shows, when the session's folder holds repositories: the one asked for, else the first of
 * those that `fit`. `repos` lists those offered as tabs. Both are undefined when the folder is itself the repository.
 */
export function panelRepo(
  s: SessionInfo,
  asked: string | undefined,
  fit: (r: SessionRepo) => boolean = () => true,
): { repos?: SessionRepo[]; selected?: SessionRepo } {
  const repos = s.repos?.filter(fit);
  if (!repos) return {};
  return { repos, selected: repos.find((r) => r.path === asked) ?? repos[0] };
}

/** One tab per repository inside the session's folder; the panel follows the tab. */
export function RepoTabs({ repos, selected, onSelect }: { repos: SessionRepo[]; selected: string; onSelect: (path: string) => void }) {
  return (
    <div role="tablist" aria-label="リポジトリ" className="scrollbar-none -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-border px-4">
      {repos.map((r) => {
        const on = r.path === selected;
        return (
          <button
            key={r.path}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(r.path)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {r.path}
          </button>
        );
      })}
    </div>
  );
}
