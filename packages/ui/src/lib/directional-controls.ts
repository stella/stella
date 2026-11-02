/**
 * Explicit embeddings (U+202A, U+202B), overrides (U+202D, U+202E), their
 * terminator (U+202C) and isolates (U+2066..U+2069). Each one reorders the
 * text that follows it. The implicit marks U+200E and U+200F stay: they only
 * set the direction of the neutral characters beside them, which right-to-left
 * names can rely on.
 *
 * This module imports nothing, so the API contract can share it with the
 * design system that renders the same names.
 */
const DIRECTIONAL_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Isolation shields the text around a value, not the value itself: a
 * directional control inside it still reorders its letters. Text a person
 * typed loses these controls before it is stored and again before it renders.
 */
export const stripDirectionalControls = (text: string): string =>
  text.replaceAll(DIRECTIONAL_CONTROLS, "");
