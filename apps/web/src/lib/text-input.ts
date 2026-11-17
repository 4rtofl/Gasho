// What a text box does with keys and pastes that also mean something to the page around it.

/**
 * Whether a key is pressed for a Japanese (or other) input method. Safari sends the Enter that ends a conversion after
 * the conversion has ended (isComposing is false), with keyCode 229.
 */
export const composing = (e: { nativeEvent: { isComposing: boolean }; keyCode: number }) => e.nativeEvent.isComposing || e.keyCode === 229;

/**
 * The files a paste attaches. None when files cannot be attached, or when the clipboard also has text: an app such as
 * Excel on a Mac puts a picture of what was copied beside its text. A file copied in the Finder comes without text.
 */
export function pastedFiles(data: { files: ArrayLike<File>; getData(type: string): string }, canAttach: boolean): File[] {
  if (!canAttach || data.getData("text/plain").trim()) return [];
  return Array.from(data.files);
}
