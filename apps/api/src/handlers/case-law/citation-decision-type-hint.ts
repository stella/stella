/**
 * The decision-type word a citation is introduced with, read from the text.
 *
 * Courts cite a file by its docket number, and a file may hold several
 * decisions: the nález on the merits and the usnesení that prepared it
 * share one spisová značka. The citing sentence usually says which one it
 * means ("nález sp. zn. II. ÚS 2766/14", "usnesením Nejvyššího soudu ze dne
 * 11. 6. 2014, č. j. 30 Cdo 292/2014-493"). The extractor's regex keeps the
 * number and drops that word; this keeps it, as a hint the resolver prefers
 * over any inference about the file's structure.
 *
 * A hint is a family, not a spelling: the Czech and Slovak words for one
 * kind of decision map to one value, and the resolver matches every stored
 * `decision_type` spelling in that family. The stored set is small so the
 * CHECK on the column stays honest.
 */

export const CITATION_DECISION_TYPE_HINT = {
  MERITS: "nález",
  ORDER: "usnesení",
  JUDGMENT: "rozsudek",
  OPINION: "stanovisko",
} as const;

export type CitationDecisionTypeHint =
  (typeof CITATION_DECISION_TYPE_HINT)[keyof typeof CITATION_DECISION_TYPE_HINT];

/** The same values as a list, for the column's CHECK. */
export const CITATION_DECISION_TYPE_HINTS = [
  CITATION_DECISION_TYPE_HINT.MERITS,
  CITATION_DECISION_TYPE_HINT.ORDER,
  CITATION_DECISION_TYPE_HINT.JUDGMENT,
  CITATION_DECISION_TYPE_HINT.OPINION,
] as const;

/**
 * Which stored `decision_type` values each hint names, lowercase, as the
 * adapters write them for the Czech and Slovak courts. A hint matches a
 * candidate when `lower(decision_type)` is in its family.
 */
export const CITATION_DECISION_TYPE_HINT_FAMILIES = {
  [CITATION_DECISION_TYPE_HINT.MERITS]: ["nález"],
  [CITATION_DECISION_TYPE_HINT.ORDER]: ["usnesení", "uznesenie"],
  [CITATION_DECISION_TYPE_HINT.JUDGMENT]: ["rozsudek", "rozsudok"],
  [CITATION_DECISION_TYPE_HINT.OPINION]: ["stanovisko", "stanovisko pléna"],
} as const satisfies Record<CitationDecisionTypeHint, readonly string[]>;

/**
 * Inflected forms, Czech and Slovak, lowercase, each mapped to its family.
 * Plurals are included because an enumeration ("nálezy sp. zn. … a …")
 * introduces every number in it with one word.
 */
const HINT_WORDS = new Map<string, CitationDecisionTypeHint>(
  Object.entries({
    nález: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezu: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezem: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezom: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezy: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezů: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezov: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezech: CITATION_DECISION_TYPE_HINT.MERITS,
    nálezoch: CITATION_DECISION_TYPE_HINT.MERITS,
    usnesení: CITATION_DECISION_TYPE_HINT.ORDER,
    usnesením: CITATION_DECISION_TYPE_HINT.ORDER,
    usneseních: CITATION_DECISION_TYPE_HINT.ORDER,
    uznesenie: CITATION_DECISION_TYPE_HINT.ORDER,
    uznesenia: CITATION_DECISION_TYPE_HINT.ORDER,
    uzneseniu: CITATION_DECISION_TYPE_HINT.ORDER,
    uznesením: CITATION_DECISION_TYPE_HINT.ORDER,
    uzneseniach: CITATION_DECISION_TYPE_HINT.ORDER,
    rozsudek: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudku: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudkem: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudky: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudků: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudcích: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudok: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudkom: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudkov: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    rozsudkoch: CITATION_DECISION_TYPE_HINT.JUDGMENT,
    stanovisko: CITATION_DECISION_TYPE_HINT.OPINION,
    stanoviska: CITATION_DECISION_TYPE_HINT.OPINION,
    stanovisku: CITATION_DECISION_TYPE_HINT.OPINION,
    stanoviskem: CITATION_DECISION_TYPE_HINT.OPINION,
    stanoviskom: CITATION_DECISION_TYPE_HINT.OPINION,
  } satisfies Record<string, CitationDecisionTypeHint>),
);

/**
 * How far before the number the introducing word may stand, and how many
 * tokens may sit between them. "usnesením Nejvyššího soudu ze dne 11. 6.
 * 2014, č. j." is nine tokens and 48 characters; the bounds leave room for a
 * longer court name, not for an earlier clause.
 */
const HINT_WINDOW_CHARS = 96;
const HINT_MAX_BRIDGE_TOKENS = 12;

/**
 * What may stand between the word and the number without breaking the
 * bond: words (the court's name, "ze dne"), the date and docket labels
 * ("11.", "6.", "2014,", "sp.", "zn.", "č.", "j."), and bare punctuation.
 * A token carrying a slash is a docket number of its own, and the word
 * before it introduced that one, not this one.
 */
const BRIDGE_TOKEN = /^[(\p{L}\d.,;:)\-–]+$/u;
const DOCKET_NUMBER = /\//u;

const LEADING_PUNCTUATION = new Set(["(", "„", '"', "'"]);
const TRAILING_PUNCTUATION = new Set([",", ";", ":", ".", ")", "“", '"', "'"]);

// Index scans rather than `^[…]+|[…]+$`: an unanchored trailing class is
// quadratic on a long punctuation run, and token text comes from the corpus.
const stripToken = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start] ?? "")) {
    start += 1;
  }
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1] ?? "")) {
    end -= 1;
  }
  return token.slice(start, end).toLowerCase();
};

/**
 * The decision-type word that introduces the citation starting at
 * `matchIndex` in `text`, or null when no word binds to it. Walks back from
 * the number, token by token: the nearest hint word wins, a docket number or
 * any token outside the bridge vocabulary ends the walk. Conservative by
 * construction: no hint beats a wrong one.
 */
export const detectCitationDecisionTypeHint = (
  text: string,
  matchIndex: number,
): CitationDecisionTypeHint | null => {
  const windowStart = Math.max(0, matchIndex - HINT_WINDOW_CHARS);
  const tokens = text.slice(windowStart, matchIndex).trim().split(/\s+/u);
  let bridged = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const raw = tokens[i] ?? "";
    if (raw === "") {
      continue;
    }
    if (DOCKET_NUMBER.test(raw) || !BRIDGE_TOKEN.test(raw)) {
      return null;
    }
    // A Map, not an object: a token such as "constructor" must not find a
    // prototype member.
    const hint = HINT_WORDS.get(stripToken(raw));
    if (hint !== undefined) {
      return hint;
    }
    bridged += 1;
    if (bridged >= HINT_MAX_BRIDGE_TOKENS) {
      return null;
    }
  }
  return null;
};
