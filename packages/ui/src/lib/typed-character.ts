/** The keyboard event fields {@link typedCharacter} reads. */
export type TypedCharacterEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "getModifierState" | "isComposing" | "key" | "metaKey"
>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const isSingleGrapheme = (text: string): boolean => {
  const first = graphemes.segment(text)[Symbol.iterator]().next();
  return !first.done && first.value.segment === text;
};

/**
 * The character a keystroke typed, or `null` for a named key ("Enter",
 * "Dead"), IME composition, or a command chord.
 *
 * `key` already holds what the layout produced, so modifiers matter only when
 * they make the press a command. Alt alone is text input: Czech, Slovak and
 * German macOS layouts type "@", "{", "[", "|" and "~" with Option, and
 * Chrome on macOS never reports AltGraph. Windows AltGr arrives as Ctrl+Alt,
 * usually but not always with the AltGraph state. Only Cmd/Win, or Ctrl
 * without Alt or AltGraph, is a command chord.
 */
export const typedCharacter = (event: TypedCharacterEvent): string | null => {
  if (event.isComposing || event.metaKey) {
    return null;
  }
  const isAltGraph = event.altKey || event.getModifierState("AltGraph");
  if (event.ctrlKey && !isAltGraph) {
    return null;
  }
  return isSingleGrapheme(event.key) ? event.key : null;
};
