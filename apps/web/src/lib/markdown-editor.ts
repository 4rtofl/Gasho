// The chat box's editor (CodeMirror 6) shows Markdown formatted as it is typed, as Obsidian does: the marks (`**`, "`",
// "# ", "> ", a link's "](url)") are hidden, and shown again on what the cursor is in or next to. Only how the text
// looks changes: what is sent is the Markdown as typed. Tables, images and raw HTML stay as typed.
import { EditorSelection, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";

const markdown = parser.configure(GFM);

export const parseMarkdown = (doc: string): Tree => markdown.parse(doc);

/** How a part of the text looks: hidden, a list's mark drawn as a bullet, a style, or a style of a whole line. */
export type Look =
  | { kind: "hide"; from: number; to: number }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "mark"; from: number; to: number; className: string }
  | { kind: "line"; at: number; className: string };

const INLINE: Record<string, [style: string, mark: string]> = {
  StrongEmphasis: ["cm-md-strong", "EmphasisMark"],
  Emphasis: ["cm-md-em", "EmphasisMark"],
  Strikethrough: ["cm-md-del", "StrikethroughMark"],
};

/**
 * How the text looks while the cursor is at `selection`: the marks of what a range touches are shown. Without a
 * selection (the box is not being typed in), every mark is hidden.
 */
export function previewLooks(tree: Tree, doc: Text, selection: readonly { from: number; to: number }[] | null): Look[] {
  const looks: Look[] = [];
  const touches = (from: number, to: number) => selection?.some((r) => r.from <= to && r.to >= from) ?? false;
  const onLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const hide = (from: number, to: number) => from < to && looks.push({ kind: "hide", from, to });
  const mark = (from: number, to: number, className: string) => from < to && looks.push({ kind: "mark", from, to, className });
  const lines = (from: number, to: number, className: (n: number, last: boolean) => string) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) looks.push({ kind: "line", at: doc.line(n).from, className: className(n - first, n === last) });
  };
  const space = (at: number) => doc.sliceString(at, at + 1) === " ";
  const marks = (node: SyntaxNode, name: string) => node.getChildren(name);

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const inline = INLINE[ref.name];
      if (inline) {
        mark(node.from, node.to, inline[0]);
        if (!touches(node.from, node.to)) for (const m of marks(node, inline[1])) hide(m.from, m.to);
        return;
      }
      switch (ref.name) {
        case "InlineCode": {
          const [open, close] = marks(node, "CodeMark");
          if (!open || !close) return;
          mark(open.to, close.from, "cm-md-code");
          if (!touches(node.from, node.to)) {
            hide(open.from, open.to);
            hide(close.from, close.to);
          }
          return;
        }
        case "Link": {
          // "[text]" alone is a reference, which Markdown shows as typed unless the text defines it elsewhere.
          const [open, close] = marks(node, "LinkMark");
          if (!open || !close || !node.getChild("URL")) return;
          mark(open.to, close.from, "cm-md-link");
          // An address on the next line ("](" then a line break) stays as typed: CodeMirror throws on a line break
          // hidden by a plugin, and the editor then stops showing what is typed.
          if (!touches(node.from, node.to) && doc.lineAt(close.from).number === doc.lineAt(node.to).number) {
            hide(open.from, open.to);
            hide(close.from, node.to);
          }
          return;
        }
        case "Autolink": {
          const url = node.getChild("URL");
          if (url) mark(url.from, url.to, "cm-md-link");
          if (!touches(node.from, node.to)) for (const m of marks(node, "LinkMark")) hide(m.from, m.to);
          return false;
        }
        case "URL":
          // A web address written on its own. A link's is among its marks.
          if (node.parent?.name !== "Link") mark(node.from, node.to, "cm-md-link");
          return;
        case "Escape":
          if (!touches(node.from, node.to)) hide(node.from, node.from + 1);
          return;
        case "Image":
          return false;
        case "QuoteMark":
          if (!onLines(node.from, node.to)) hide(node.from, node.to + (space(node.to) ? 1 : 0));
          return;
        case "Blockquote":
          lines(node.from, node.to, () => "cm-md-quote");
          return;
        case "ListMark":
          if (node.parent?.parent?.name === "BulletList" && !touches(node.from, node.to + 1))
            looks.push({ kind: "bullet", from: node.from, to: node.to });
          return;
        case "FencedCode": {
          const hidden = !onLines(node.from, node.to);
          const fences = marks(node, "CodeMark");
          const closed = fences.length === 2 && doc.lineAt(node.to).number > doc.lineAt(node.from).number;
          lines(node.from, node.to, (i, last) =>
            [
              "cm-md-codeblock",
              i === 0 && "cm-md-codeblock-first",
              last && "cm-md-codeblock-last",
              hidden && (i === 0 || (last && closed)) && "cm-md-fence",
            ]
              .filter(Boolean)
              .join(" "),
          );
          if (hidden) {
            const open = doc.lineAt(node.from);
            hide(open.from, open.to);
            if (closed) {
              const close = doc.lineAt(node.to);
              hide(close.from, close.to);
            }
          }
          return false;
        }
        case "CodeBlock":
          lines(node.from, node.to, (i, last) => ["cm-md-codeblock", i === 0 && "cm-md-codeblock-first", last && "cm-md-codeblock-last"].filter(Boolean).join(" "));
          return false;
      }
      const heading = /^ATXHeading(\d)$/.exec(ref.name)?.[1];
      if (heading) {
        lines(node.from, node.from, () => `cm-md-h${heading}`);
        if (!onLines(node.from, node.to)) {
          marks(node, "HeaderMark").forEach((m, i) =>
            i === 0 ? hide(m.from, m.to + (space(m.to) ? 1 : 0)) : hide(m.from - (space(m.from - 1) ? 1 : 0), m.to),
          );
        }
      }
    },
  });
  return looks;
}

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-md-bullet";
    dot.textContent = "•";
    return dot;
  }
}

const HIDE = Decoration.replace({});
const BULLET = Decoration.replace({ widget: new Bullet() });

/** One decoration for each class name, made the first time it is asked for. */
function byClass(make: (spec: { class: string }) => Decoration): (className: string) => Decoration {
  const made = new Map<string, Decoration>();
  return (className) => {
    let d = made.get(className);
    if (!d) made.set(className, (d = make({ class: className })));
    return d;
  };
}
const markOf = byClass((spec) => Decoration.mark(spec));
const lineOf = byClass((spec) => Decoration.line(spec));

function decorations(looks: Look[]): DecorationSet {
  return Decoration.set(
    looks.map((l) =>
      l.kind === "hide"
        ? HIDE.range(l.from, l.to)
        : l.kind === "bullet"
          ? BULLET.range(l.from, l.to)
          : l.kind === "mark"
            ? markOf(l.className).range(l.from, l.to)
            : lineOf(l.className).range(l.at),
    ),
    true,
  );
}

const tree = StateField.define<Tree>({
  create: (state) => parseMarkdown(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? parseMarkdown(tr.newDoc.toString()) : value),
});

const preview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** The looks were kept through a composition, and are to be made again (at the update that ends it). */
    stale = false;
    constructor(view: EditorView) {
      this.decorations = this.make(view);
    }
    make(view: EditorView) {
      return decorations(previewLooks(view.state.field(tree), view.state.doc, view.hasFocus ? view.state.selection.ranges : null));
    }
    update(u: ViewUpdate) {
      // While a word is being composed (Japanese), the text around it is left as it is drawn, so that the editor does
      // not change the page next to what the input method is writing.
      if (u.view.composing) {
        this.decorations = this.decorations.map(u.changes);
        this.stale = true;
      } else if (this.stale || u.docChanged || u.selectionSet || u.focusChanged) {
        this.decorations = this.make(u.view);
        this.stale = false;
      }
    }
  },
  { decorations: (p) => p.decorations },
);

/** The marks hidden and the text styled, as in the conversation. Left out for a shell command. */
export const markdownLooks: Extension = [tree, preview];

const MONO = "var(--font-mono, ui-monospace, monospace)";

/** The editor in the chat box's look: the box's font and colors, no frame of its own, and the Markdown styles. */
export const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflowY: "hidden" },
  ".cm-content": { padding: "8px 12px", caretColor: "currentColor" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--color-neutral-500, #737373)" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-del": { textDecoration: "line-through", color: "var(--muted-foreground)" },
  ".cm-md-code": {
    fontFamily: MONO,
    fontSize: "0.86em",
    backgroundColor: "var(--surface-raised)",
    borderRadius: "0.375rem",
    padding: "0.125rem 0.375rem",
  },
  ".cm-md-link": { textDecoration: "underline", textDecorationColor: "var(--color-neutral-500, #737373)", textUnderlineOffset: "2px" },
  ".cm-md-h1": { fontSize: "1.25em", fontWeight: "600" },
  ".cm-md-h2": { fontSize: "1.125em", fontWeight: "600" },
  ".cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6": { fontWeight: "600" },
  ".cm-line.cm-md-quote": { borderLeft: "2px solid var(--border)", paddingLeft: "0.75rem", color: "var(--muted-foreground)" },
  ".cm-md-bullet": { color: "var(--muted-foreground)" },
  ".cm-line.cm-md-codeblock": { fontFamily: MONO, fontSize: "0.86em", backgroundColor: "var(--surface-raised)", padding: "0 0.75rem" },
  ".cm-line.cm-md-codeblock-first": { borderTopLeftRadius: "0.5rem", borderTopRightRadius: "0.5rem", paddingTop: "0.25rem" },
  ".cm-line.cm-md-codeblock-last": { borderBottomLeftRadius: "0.5rem", borderBottomRightRadius: "0.5rem", paddingBottom: "0.25rem" },
  // A fence whose marks are hidden: a little room above or below the code.
  ".cm-line.cm-md-fence": { lineHeight: "0.25rem" },
});

/** The cursor (anchor, head) of the chat box's editor inside `box`, while it is being typed in. */
export function caretIn(box: HTMLElement): [number, number] | undefined {
  const view = EditorView.findFromDOM(box);
  if (!view?.hasFocus) return undefined;
  const { anchor, head } = view.state.selection.main;
  return [anchor, head];
}

/** Puts the cursor of the chat box's editor inside `box` at `caret`, and the focus in it. */
export function putCaret(box: HTMLElement, [anchor, head]: [number, number]): void {
  const view = EditorView.findFromDOM(box);
  if (!view) return;
  const n = view.state.doc.length;
  view.dispatch({ selection: EditorSelection.single(Math.min(anchor, n), Math.min(head, n)) });
  view.focus();
}
