/**
 * Template-level language metadata helpers.
 *
 * Templates are often bilingual legal documents (e.g. a Polish|English
 * two-column contract), so `templates.languages` stores ordered BCP-47
 * tags: primary language first. Validation accepts any structurally
 * well-formed tag (via `Intl`), not only the app locales, because legal
 * documents legitimately use languages the UI is not translated into.
 */

import { Result } from "better-result";

import { extractText } from "@/api/handlers/docx/extract-text";
import { isPlausibleLocale } from "@/api/handlers/docx/types";

export const MAX_TEMPLATE_LANGUAGES = 4;

type NormalizeTemplateLanguagesResult =
  | { ok: true; languages: string[] }
  | { ok: false; message: string };

/**
 * Trims, validates, canonicalizes ("EN-gb" -> "en-GB"), and dedupes a
 * client-supplied list of language tags, preserving order. Returns a
 * failure message suitable for a 400 response on the first invalid tag.
 */
export const normalizeTemplateLanguages = (
  input: readonly string[],
): NormalizeTemplateLanguagesResult => {
  const languages: string[] = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!isPlausibleLocale(trimmed)) {
      return { ok: false, message: `Invalid language tag: ${trimmed}` };
    }
    // Cannot throw here: isPlausibleLocale already proved the tag is
    // structurally well-formed for Intl.
    const canonical = Intl.getCanonicalLocales(trimmed).at(0) ?? trimmed;
    if (!languages.includes(canonical)) {
      languages.push(canonical);
    }
  }
  if (languages.length > MAX_TEMPLATE_LANGUAGES) {
    return {
      ok: false,
      message: `At most ${String(MAX_TEMPLATE_LANGUAGES)} languages are allowed`,
    };
  }
  return { ok: true, languages };
};

// ── Best-effort detection ────────────────────────────────

/**
 * Function-word markers for the languages the app ships translations for
 * (base tags; regional variants are indistinguishable by stopwords).
 *
 * The sets are pairwise disjoint by construction: words shared between
 * languages (cs/sk "že", es/pt "que", lt/lv "ir", fr/lv "par", ...) are
 * deliberately omitted so a hit is unambiguous evidence. Diacritics are
 * preserved, which is what separates close pairs like cs "při" / sk "pri".
 */
export const LANGUAGE_STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  cs: "podle která které který být jsou této nebo pokud již mezi při".split(
    " ",
  ),
  de: "der die das und nicht ist von mit für dem den ein eine oder werden im auf zur zum".split(
    " ",
  ),
  en: "the and of that is for with this shall be by any such or are not".split(
    " ",
  ),
  es: "el los las y del su sus una según deberá cuando mediante".split(" "),
  et: "ja on ei või ning kui oma selle mis poolt vahel".split(" "),
  fr: "les des dans est pour qui une du au aux sur ne pas cette être sont".split(
    " ",
  ),
  hu: "az és hogy nem vagy egy szerint által között esetén valamint illetve".split(
    " ",
  ),
  lt: "yra kad arba pagal šios tarp kaip taip jeigu kurios į".split(" "),
  lv: "un ka ar no vai saskaņā šīs starp kā tiek līdz".split(" "),
  pl: "i się nie jest oraz przez które która lub są dla być zgodnie niniejszej".split(
    " ",
  ),
  pt: "os ao não são uma pelo pela em quando seus também da".split(" "),
  sk: "podľa ktorá ktoré ktorý byť sú tejto alebo ak už medzi pri".split(" "),
};

const LANGUAGE_BY_STOPWORD: ReadonlyMap<string, string> = new Map(
  Object.entries(LANGUAGE_STOPWORDS).flatMap(([tag, words]) =>
    words.map((word): [string, string] => [word, tag]),
  ),
);

/** Detection reads at most this many characters; bilingual legal documents
 *  establish both languages well before this point. */
const MAX_DETECTION_CHARS = 40_000;
/** Floors below which a language is considered noise rather than content. */
const MIN_HITS = 4;
const MIN_SCORE = 0.02;
/** A secondary language must reach this fraction of the top score, so a
 *  stray foreign clause does not mark a document as bilingual. */
const SECONDARY_RATIO = 0.35;

/**
 * Best-effort stopword heuristic over the supported base languages.
 * Returns ordered base BCP-47 tags (dominant language first), or [] when
 * nothing is confidently detected. Pure; callers persist the result.
 */
export const detectTemplateLanguages = (text: string): string[] => {
  const tokens = text
    .slice(0, MAX_DETECTION_CHARS)
    .toLowerCase()
    .match(/\p{L}+/gu);
  if (!tokens) {
    return [];
  }

  const hitsByTag = new Map<string, number>();
  for (const token of tokens) {
    const tag = LANGUAGE_BY_STOPWORD.get(token);
    if (tag !== undefined) {
      hitsByTag.set(tag, (hitsByTag.get(tag) ?? 0) + 1);
    }
  }

  const scored = [...hitsByTag.entries()]
    .map(([tag, hits]) => ({ tag, hits, score: hits / tokens.length }))
    .filter((entry) => entry.hits >= MIN_HITS && entry.score >= MIN_SCORE)
    .sort((a, b) => b.hits - a.hits);

  const top = scored.at(0);
  if (!top) {
    return [];
  }

  return scored
    .filter((entry) => entry.score >= top.score * SECONDARY_RATIO)
    .slice(0, MAX_TEMPLATE_LANGUAGES)
    .map((entry) => entry.tag);
};

/** Best-effort: extraction failures yield [] rather than failing the
 *  surrounding create flow (languages stay editable afterwards). */
export const detectTemplateLanguagesFromDocx = async (
  docx: Uint8Array,
): Promise<string[]> => {
  const extracted = await Result.tryPromise(
    async () => await extractText(docx),
  );
  if (Result.isError(extracted)) {
    return [];
  }
  return detectTemplateLanguages(
    extracted.value.paragraphs.map((paragraph) => paragraph.text).join("\n"),
  );
};
