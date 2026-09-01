import { foldToAscii } from "@stll/text-normalize";

import {
  resolveStatuteAlias,
  type StatuteAliasTarget,
} from "@/features/statutes/statute-aliases";
import type { StatuteCountry } from "@/lib/statute-route";

/**
 * What a statute box entry asks for. An act is addressed by number (with the
 * collection when the entry names one) or by an alias the jurisdiction knows;
 * anything else is text to search titles by.
 */
export type StatuteQueryIntent =
  | { type: "empty" }
  | {
      type: "act";
      collection: string | null;
      /** The alias's short name, when the entry used one instead of a number. */
      label: string | null;
      number: string;
      /**
       * The provision designation the entry named ahead of the act
       * (`§ 2079` in `§ 2079 89/2012`), in the form the reader's jump field
       * parses.
       */
      provision: string | null;
      year: string;
    }
  | { type: "text"; text: string };

/**
 * The comparison form of an entry: compatibility-normalised (full-width
 * digits and spaces), diacritics folded the way the title index folds them,
 * lower-case, runs of any whitespace collapsed to one space.
 */
export const foldStatuteQuery = (raw: string): string =>
  foldToAscii(raw.normalize("NFKC")).toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * Publisher collections as lawyers abbreviate them, mapped to the collection
 * segment of the publisher's ELI. The Czech official gazette (`Ú. l.`) was
 * split into two ELI collections, so its abbreviation names no single one.
 */
const COLLECTION_BY_ABBREVIATION = {
  cze: { sb: "sb", ul: null },
  svk: { zb: "zz", zz: "zz" },
} as const satisfies Record<StatuteCountry, Record<string, string | null>>;

/** `Sb.`, `Z. z.`, `Ú.l. I` → `sb`, `zz`, `ul`: dots, spaces and series dropped. */
const canonicalCollectionAbbreviation = (suffix: string): string =>
  suffix.replace(/ i{1,2}$/u, "").replaceAll(/[.\s]/gu, "");

// The patterns below run on folded text, where every whitespace run is one
// space, so they spell spaces literally instead of with `\s*` runs: two
// adjacent unbounded quantifiers are what makes a regex backtrack
// super-linearly, and the ratchet forbids them.

// `§ 2079`, `par. 3`, `cl. 10`, optionally followed by a paragraph and a
// letter, then the act. The designation (marker and number) is kept as the
// reader's jump field expects it; the paragraph is not addressable there.
const PROVISION_PREFIX_RE =
  /^(§|par\.?|cl\.?|art\.?) ?(\d+[a-z]*)(?: odst\.? ?\d+[a-z]*)?(?: pism\.? ?[a-z]\)?)? (.+)$/u;

// One word that may precede a number: the act word, the ordinal word, the
// "č." sign. Stripped one at a time, so `zákon č. 89/2012` sheds two.
const ACT_PREFIX_WORD_RE =
  /^(?:c\.|zakon[a-z]*|zak\.|z\.|vyhlaska|vyhl\.|narizeni|nariadenie|nar\.) ?/u;
const ACT_PREFIX_WORDS_MAX = 4;

const ACT_NUMBER_RE =
  /^(\d{1,5}) ?\/ ?(\d{4})(?: ?(sb\.?|zb\.?|z\. ?z\.?|u\. ?l\.(?: i{1,2})?))?$/u;

const stripActPrefixWords = (folded: string): string => {
  let rest = folded;
  for (let words = 0; words < ACT_PREFIX_WORDS_MAX; words += 1) {
    const next = rest.replace(ACT_PREFIX_WORD_RE, "");
    if (next === rest) {
      break;
    }
    rest = next;
  }
  return rest;
};

const actFromNumber = (
  country: StatuteCountry,
  folded: string,
  provision: string | null,
): StatuteQueryIntent | null => {
  const match = ACT_NUMBER_RE.exec(stripActPrefixWords(folded));
  const ordinal = match?.[1];
  const year = match?.[2];
  if (ordinal === undefined || year === undefined) {
    return null;
  }
  const suffix = match?.[3];
  const collections: Record<string, string | null> =
    COLLECTION_BY_ABBREVIATION[country];
  let collection: string | null = null;
  if (suffix !== undefined) {
    const abbreviation = canonicalCollectionAbbreviation(suffix);
    // A collection this jurisdiction does not publish (`Z. z.` while reading
    // Czech law) is not a reference into it; widening it to "any collection"
    // would open a different act under the same number.
    if (!Object.hasOwn(collections, abbreviation)) {
      return null;
    }
    collection = collections[abbreviation] ?? null;
  }

  return {
    type: "act",
    collection,
    label: null,
    number: String(Number(ordinal)),
    provision,
    year,
  };
};

const actFromAlias = (
  target: StatuteAliasTarget,
  provision: string | null,
): StatuteQueryIntent => ({
  type: "act",
  collection: target.collection,
  label: target.label,
  number: target.number,
  provision,
  year: target.year,
});

const actIntent = (
  country: StatuteCountry,
  folded: string,
  provision: string | null,
): StatuteQueryIntent | null => {
  const byNumber = actFromNumber(country, folded, provision);
  if (byNumber !== null) {
    return byNumber;
  }
  const alias = resolveStatuteAlias(country, folded);
  return alias === null ? null : actFromAlias(alias, provision);
};

/**
 * Read an entry as an act reference where it is one. Number grammar is lenient
 * about spacing and about the words around the number; aliases are matched
 * whole after folding, so `OSŘ` and `osr` name the same act. Anything the
 * grammar does not claim is a title search, verbatim.
 */
export const parseStatuteQuery = (
  country: StatuteCountry,
  raw: string,
): StatuteQueryIntent => {
  const text = raw.trim();
  if (text.length === 0) {
    return { type: "empty" };
  }
  const folded = foldStatuteQuery(text);

  const provisionMatch = PROVISION_PREFIX_RE.exec(folded);
  const marker = provisionMatch?.[1];
  const provisionNumber = provisionMatch?.[2];
  const afterProvision = provisionMatch?.[3];
  if (
    marker !== undefined &&
    provisionNumber !== undefined &&
    afterProvision !== undefined
  ) {
    const act = actIntent(
      country,
      stripActPrefixWords(afterProvision),
      `${marker} ${provisionNumber}`,
    );
    if (act !== null) {
      return act;
    }
  }

  return actIntent(country, folded, null) ?? { type: "text", text };
};
