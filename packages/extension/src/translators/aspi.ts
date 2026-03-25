import type { Translator } from "./types";

/**
 * Translator for ASPI (Automatizovany system pravnich informaci).
 * Czech legal information system.
 *
 * TODO: implement real extraction from ASPI DOM structure.
 */
export const aspiTranslator: Translator = {
  name: "ASPI",
  pattern: /aspi\.cz|beck-online\.cz.*aspi/i,
  extract: (_doc) => {
    // TODO: implement extraction from ASPI DOM structure.
    return null;
  },
};
