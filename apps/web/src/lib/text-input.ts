// What a text box does with keys and pastes that also mean something to the page around it.

/**
 * Whether a key is pressed for a Japanese (or other) input method. Safari sends the Enter that ends a conversion after
 * the conversion has ended (isComposing is false), with keyCode 229.
 */
export const composing = (e: { nativeEvent: { isComposing: boolean }; keyCode: number }) => e.nativeEvent.isComposing || e.keyCode === 229;

/** Whether a key closes the panel it is pressed in: Esc, but not the Esc that cancels a conversion (Chrome sends it as Escape). */
export const closesPanel = (e: { key: string; nativeEvent: { isComposing: boolean }; keyCode: number }) => e.key === "Escape" && !composing(e);
