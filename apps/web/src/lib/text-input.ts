// What a text box does with keys and pastes that also mean something to the page around it.

/**
 * Whether a key is pressed for a Japanese (or other) input method. Safari sends the Enter that ends a conversion after
 * the conversion has ended (isComposing is false), with keyCode 229.
 */
export const composing = (e: { nativeEvent: { isComposing: boolean }; keyCode: number }) => e.nativeEvent.isComposing || e.keyCode === 229;
