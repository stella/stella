/**
 * The court a citation names, read from the citing sentence.
 *
 * A Czech or Slovak court cites a decision as "rozsudek Krajského soudu v
 * Českých Budějovicích ze dne 21. 5. 2025, č. j. 65 A 3/2025-226". The docket
 * number alone does not identify the decision: regional courts number their
 * files independently, so `65 A 3/2025` exists at several of them at once and
 * the resolver's uniqueness rule cannot pick one. The court phrase does. The
 * extractor's regex keeps the number and drops the phrase; this keeps it,
 * verbatim, as a hint the resolver matches against each candidate's court.
 *
 * The phrase is inflected (genitive after "rozsudek"/"usnesení"), while the
 * corpus stores courts in the nominative. Both sides go through one SQL
 * normalization, `courtNameKeySql`, so the comparison never depends on a
 * per-court spelling list.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/** Fits the column; a court name is a few words, not a paragraph. */
export const CITATION_COURT_HINT_MAX_LENGTH = 128;

/**
 * How far before the number the court phrase may begin. The longest common
 * form, "rozsudku Krajského soudu v Ústí nad Labem – pobočky v Liberci ze
 * dne 11. 12. 2019, č. j.", is under a hundred characters.
 */
const COURT_WINDOW_CHARS = 140;

// The court phrase, assembled from its parts. Every fragment is a plain
// source string joined into one `u`-flagged expression below; nothing is
// interpolated from input.

/** `Krajského`, `Nejvyššího`, `Ústavního`: the phrase opens capitalised. */
const QUALIFIER = String.raw`\p{Lu}\p{Ll}+`;
/** `správního`: further qualifiers are lowercase, at most two. */
const MORE_QUALIFIERS = String.raw`(?:\p{Ll}+\s+){0,2}`;
/** `soud`, `soudu`, `súd`, `súdu`: the noun in any case. */
const COURT_NOUN = String.raw`s(?:ou|ú)d\p{Ll}*`;
/** A proper name: `Brně`, `Ústí`, `Labem`, `Liberci`. */
const PLACE = String.raw`\p{Lu}\p{L}+`;
/** `v Brně`, `v Ústí nad Labem`, `v Hradci Králové`. */
const SEAT = String.raw`\s+(?:v|ve|vo)\s+${PLACE}(?:\s+(?:nad|pod)\s+${PLACE})?(?:\s+${PLACE})?`;
/** `– pobočky v Liberci`, after a seat. */
const BRANCH = String.raw`\s+[–-]\s+pobo\p{Ll}+\s+(?:v|ve)\s+${PLACE}`;
/** `Slovenskej republiky`, `České republiky`: the supreme courts' suffix. */
const STATE = String.raw`\s+(?:Slovensk|Česk)\p{Ll}+\s+republik\p{Ll}+`;
const COURT_PHRASE = String.raw`${QUALIFIER}\s+${MORE_QUALIFIERS}${COURT_NOUN}(?:${SEAT}(?:${BRANCH})?|${STATE})?`;

/** `ze dne 21. 5. 2025`, `zo dňa 25. 3. 2015`, `z 12. 1. 2020`. */
const DECISION_DATE = String.raw`\s+(?:ze|zo|z)\s+(?:d[nň][eaě]\s+)?\d{1,2}\.\s*\d{1,2}\.\s*\d{4}`;
/** What the extractor's number pattern starts right after. */
const CITATION_MARKER = String.raw`(?:č\.\s*j\.|čj\.|sp\.\s*zn\.|spis\.\s*zn\.)`;

/**
 * The court phrase that introduces a citation, followed by at most a date and
 * the marker before the number. The date is optional: "usnesení Nejvyššího
 * soudu sp. zn. …" cites without one. Anchored to the end of the window,
 * which is where the number starts, so an earlier court mentioned in the
 * same sentence cannot bind.
 */
const COURT_PHRASE_BEFORE_CITATION = new RegExp(
  String.raw`(?<court>${COURT_PHRASE})(?:${DECISION_DATE})?,?\s*(?:${CITATION_MARKER})?\s*$`,
  "u",
);

/**
 * The court phrase bound to the citation starting at `matchIndex` in `text`,
 * or null when the sentence does not name one in the standard form.
 * Conservative by construction: a phrase the pattern does not recognise is
 * no hint, never a wrong one.
 */
export const detectCitationCourtHint = (
  text: string,
  matchIndex: number,
): string | null => {
  const windowStart = Math.max(0, matchIndex - COURT_WINDOW_CHARS);
  const window = text.slice(windowStart, matchIndex);
  const court = COURT_PHRASE_BEFORE_CITATION.exec(window)?.groups?.["court"];
  if (court === undefined) {
    return null;
  }
  const normalized = court.replace(/\s+/gu, " ").trim();
  return normalized.length > CITATION_COURT_HINT_MAX_LENGTH ? null : normalized;
};

/**
 * One court name as a comparison key, in SQL so the hint from the text and
 * the court stored on a candidate are folded the same way in the same
 * statement.
 *
 * Lowercases, strips Czech and Slovak diacritics, collapses whitespace, and
 * cuts the inflectional ending off every word. The endings list covers the
 * adjective and noun cases a court name takes in a citing sentence
 * ("Krajského soudu" → "krajsk soud", "Krajský soud" → "krajsk soud";
 * "Najvyššieho súdu" and "Najvyšší súd" both → "najvyss sud"). The stem is
 * crude on purpose: it only has to be the same function on both sides and
 * keep different courts apart, which the place name after `v` guarantees.
 */
export const courtNameKeySql = (name: SQL): SQL => sql`
  regexp_replace(
    regexp_replace(
      lower(translate(${name},
        'áäčďéěíĺľňóôöřšťúůüýžÁÄČĎÉĚÍĹĽŇÓÔÖŘŠŤÚŮÜÝŽ',
        'aacdeeillnooorstuuuyzaacdeeillnooorstuuuyz')),
      '(ieho|ého|eho|iho|ému|emu|ymi|ych|ich|ou|em|om|u|y|i|e|a|o)\\M',
      '',
      'g'
    ),
    '\\s+',
    ' ',
    'g'
  )`;
