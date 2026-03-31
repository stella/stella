import type { Translator } from "./types";

/**
 * Translator for justice.cz (Czech court registry / ISIR).
 *
 * TODO: implement real extraction from justice.cz DOM.
 */
export const justiceCzTranslator: Translator = {
  name: "justice.cz",
  pattern: /justice\.cz/i,
  extract: (_doc) => null,
};
