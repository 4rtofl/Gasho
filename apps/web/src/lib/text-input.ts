// What a text box does with keys and pastes that also mean something to the page around it.

/**
 * Whether a key is pressed for a Japanese (or other) input method. Safari sends the Enter that ends a conversion after
 * the conversion has ended (isComposing is false), with keyCode 229.
 */
export const composing = (e: { nativeEvent: { isComposing: boolean }; keyCode: number }) => e.nativeEvent.isComposing || e.keyCode === 229;

/** Whether a key closes the panel it is pressed in: Esc, but not the Esc that cancels a conversion (Chrome sends it as Escape). */
export const closesPanel = (e: { key: string; nativeEvent: { isComposing: boolean }; keyCode: number }) => e.key === "Escape" && !composing(e);

/** A dialog's onEscapeKeyDown: the Esc that cancels a conversion in one of its text boxes leaves the dialog open. */
export const keepOpenWhileComposing = (e: KeyboardEvent) => {
  if (composing({ nativeEvent: e, keyCode: e.keyCode })) e.preventDefault();
};

/**
 * The files a paste attaches. None when files cannot be attached, or when the clipboard also has text: an app such as
 * Excel on a Mac puts a picture of what was copied beside its text. Files copied in the Finder come without text, or
 * in Safari with their names as the text, one a line.
 */
export function pastedFiles(data: { files: ArrayLike<File>; getData(type: string): string }, canAttach: boolean): File[] {
  if (!canAttach) return [];
  const files = Array.from(data.files);
  // The text and the names may write a letter with a voiced mark or accent in different Unicode forms (NFD and NFC).
  const lines = data
    .getData("text/plain")
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim().normalize("NFC"))
    .filter(Boolean);
  const names = files.map((f) => f.name.trim().normalize("NFC"));
  if (lines.length && lines.sort().join("\n") !== names.sort().join("\n")) return [];
  return files;
}

/**
 * Whether the keys are those of a Mac, iPhone or iPad: ⌘ is the key for the page's shortcuts, and Ctrl with a letter
 * moves the cursor in a text box (Ctrl+B goes back a character). Elsewhere Ctrl+B does nothing in a text box.
 */
export const appleKeys = (userAgent: string) => /Mac|iPhone|iPad/i.test(userAgent);

const TEXT_TYPES = new Set(["text", "search", "url", "email", "password", "tel", "number"]);

/** Whether the keys go to a box that text is written in, where the system's keys (Ctrl+B on a Mac) move the cursor. */
export function typingIn(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_TYPES.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}
