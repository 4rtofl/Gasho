// What a text box does with keys and pastes that also mean something to the page around it.

/**
 * Whether a key is pressed for a Japanese (or other) input method. Safari sends the Enter that ends a conversion after
 * the conversion has ended (isComposing is false), with keyCode 229.
 */
export const composing = (e: { nativeEvent: { isComposing: boolean }; keyCode: number }) => e.nativeEvent.isComposing || e.keyCode === 229;

/** Whether a key closes the panel it is pressed in: Esc, but not the Esc that cancels a conversion (Chrome sends it as Escape). */
export const closesPanel = (e: { key: string; nativeEvent: { isComposing: boolean }; keyCode: number }) => e.key === "Escape" && !composing(e);

/**
 * The files a paste attaches. None when files cannot be attached, or when the clipboard also has text: an app such as
 * Excel on a Mac puts a picture of what was copied beside its text. A file copied in the Finder comes without text.
 */
export function pastedFiles(data: { files: ArrayLike<File>; getData(type: string): string }, canAttach: boolean): File[] {
  if (!canAttach || data.getData("text/plain").trim()) return [];
  return Array.from(data.files);
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
