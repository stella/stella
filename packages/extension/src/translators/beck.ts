import type { Translator } from "./types";

/**
 * Translator for Beck-online (beck-online.de).
 * German legal database.
 *
 * TODO: implement real extraction from Beck DOM structure.
 */
export const beckTranslator: Translator = {
  name: "Beck-online",
  pattern: /beck-online\.de/i,
  extract: (_doc) => null,
};
