// Text selected in one of Claude's answers in a session's conversation, for the plugins' parts shown by it (P22): the
// selection as a part of the answer's text as the conversation shows it. Each answer is drawn in an element marked
// with ANSWER_ATTR (transcript.tsx); the popup the parts are in is marked with SELECTION_POPUP_ATTR (plugins/parts.tsx).
import { useCallback, useEffect, useState, type RefObject } from "react";
import type { AnswerSelection } from "@gasho/plugin-sdk";

/** Marks the element one of Claude's answers is drawn in. */
export const ANSWER_ATTR = "data-answer";
/** Marks the popup of the parts shown by a selection. */
export const SELECTION_POPUP_ATTR = "data-answer-selection";

/** Elements that begin and end a line of an answer's text. */
const BLOCKS = new Set([
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SUMMARY",
  "TABLE",
  "TR",
  "UL",
]);
/** Gasho's controls in an answer, which are not of its text: a code block's language and its copy button. */
const LEFT_OUT = new Set(["BUTTON", "FIGCAPTION"]);

export interface AnswerText {
  text: string;
  /** Where a boundary point of a Range (a node and an offset in it) is in `text`; undefined outside the answer. */
  at(node: Node, offset: number): number | undefined;
}

/**
 * The text of an answer as the conversation shows it, as the SDK's AnswerSelection has it: what its text nodes say,
 * with a newline between its blocks (paragraphs, list items, lines of a table) and for a <br>, and a tab between the
 * cells of a table's line.
 */
export function answerText(root: Element): AnswerText {
  let text = "";
  const before = new Map<Node, number>();
  const after = new Map<Node, number>();
  const lineBreak = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const visit = (node: Node) => {
    if (!(node instanceof Element)) {
      before.set(node, text.length);
      const value = node.nodeType === Node.TEXT_NODE ? (node.nodeValue ?? "") : "";
      // Not the newlines React Markdown puts between blocks and after a <br>: the blocks and the <br> make the lines.
      if (!(value.includes("\n") && value.trim() === "")) text += value;
      after.set(node, text.length);
      return;
    }
    const tag = node.tagName;
    const block = BLOCKS.has(tag);
    if (block) lineBreak();
    if ((tag === "TD" || tag === "TH") && node.previousElementSibling) text += "\t";
    before.set(node, text.length);
    if (tag === "BR") text += "\n";
    if (!LEFT_OUT.has(tag)) for (const child of node.childNodes) visit(child);
    if (block) lineBreak();
    after.set(node, text.length);
  };
  before.set(root, 0);
  for (const child of root.childNodes) visit(child);
  after.set(root, text.length);

  const at = (node: Node, offset: number): number | undefined => {
    const start = before.get(node);
    if (start !== undefined) {
      if (node.nodeType === Node.TEXT_NODE) return Math.min(start + offset, after.get(node) ?? start);
      if (node instanceof Element && !LEFT_OUT.has(node.tagName)) {
        const child = node.childNodes[offset];
        return child ? before.get(child) : after.get(node);
      }
      return start;
    }
    // Inside a control that is left out: where the control is.
    for (let n = node.parentNode; n; n = n.parentNode) {
      const b = before.get(n);
      if (b !== undefined) return b;
    }
    return undefined;
  };
  return { text, at };
}

const answerOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(`[${ANSWER_ATTR}]`) ?? undefined;
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * What `range` selects in one of Claude's answers inside `within`, and the answer's element. Undefined when it is not
 * all in one answer, or selects only white space.
 */
export function answerSelection(range: Range, within: Element): (AnswerSelection & { container: Element }) | undefined {
  const container = answerOf(range.startContainer);
  if (!container || container !== answerOf(range.endContainer) || !within.contains(container)) return undefined;
  const { text, at } = answerText(container);
  let start = at(range.startContainer, range.startOffset);
  let end = at(range.endContainer, range.endOffset);
  if (start === undefined || end === undefined) return undefined;
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  if (start === end) return undefined;
  return { text: text.slice(start, end), answer: text.trimEnd(), start, end, container };
}

/** A selection in one of Claude's answers, as the conversation keeps it while its parts show. */
export interface TrackedSelection extends AnswerSelection {
  /** Another for every selection, so that the parts are drawn anew. */
  id: number;
  /** What was selected, where the popup is placed. */
  range: Range;
  /** The element of the answer. */
  container: Element;
}

/**
 * While the selection changes this often (dragging the handles on a phone, extending it with the keyboard), its parts
 * wait for it to stop, rather than being drawn for each step of it.
 */
const SETTLE_MS = 300;

const inPopup = (node: Node | null | undefined) =>
  Boolean((node instanceof Element ? node : node?.parentElement)?.closest(`[${SELECTION_POPUP_ATTR}]`));

/**
 * The text selected in one of Claude's answers inside `root`, while `enabled`, and a function that forgets it (Esc,
 * a press outside the popup). It is read once the mouse button is up, or once the selection has stopped changing.
 * Pressing in the popup, or selecting its text, keeps it: a press on its text clears the page's selection.
 */
export function useAnswerSelection(root: RefObject<HTMLElement | null>, enabled: boolean): [TrackedSelection | undefined, () => void] {
  const [selection, setSelection] = useState<TrackedSelection>();
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let mouseDown = false;
    let pressedInPopup = false;
    let id = 0;
    const read = () => {
      const sel = document.getSelection();
      const range = sel && sel.rangeCount === 1 && !sel.isCollapsed ? sel.getRangeAt(0) : undefined;
      const found = range && root.current ? answerSelection(range, root.current) : undefined;
      if (found && range) {
        pressedInPopup = false;
        setSelection((prev) =>
          prev?.container === found.container && prev.start === found.start && prev.end === found.end ? prev : { ...found, id: ++id, range: range.cloneRange() },
        );
      } else if (!pressedInPopup && !inPopup(range?.commonAncestorContainer)) {
        setSelection(undefined);
      }
    };
    const onChange = () => {
      clearTimeout(timer);
      if (!mouseDown) timer = setTimeout(read, SETTLE_MS);
    };
    const onDown = (e: PointerEvent) => {
      pressedInPopup = inPopup(e.target as Node | null);
      if (e.pointerType === "mouse" && e.button === 0) mouseDown = true;
    };
    const onUp = () => {
      if (!mouseDown) return;
      mouseDown = false;
      clearTimeout(timer);
      // After the browser has done with the press: a click in a selection clears it once the button is up.
      timer = setTimeout(read, 0);
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      setSelection(undefined);
    };
  }, [enabled, root]);
  return [selection, useCallback(() => setSelection(undefined), [])];
}
