import { aspiTranslator } from "./aspi";
import { beckTranslator } from "./beck";
import { justiceCzTranslator } from "./justice-cz";
import type { Translator, TranslatorResult } from "./types";

/** All registered translators, checked in order. */
const translators: Translator[] = [
  aspiTranslator,
  beckTranslator,
  justiceCzTranslator,
];

/**
 * Find the first translator whose pattern matches the given URL
 * and attempt extraction. Returns null if no translator matches
 * or extraction fails.
 */
export const runTranslators = (
  url: string,
  doc: Document,
): TranslatorResult | null => {
  for (const translator of translators) {
    if (translator.pattern.test(url)) {
      const result = translator.extract(doc);
      if (result) {
        return result;
      }
    }
  }
  return null;
};
