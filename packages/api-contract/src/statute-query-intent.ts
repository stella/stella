import { panic } from "better-result";

import { normalizeUnicode, foldToAscii } from "@stll/text-normalize";

import {
  STATUTE_ALIASES,
  resolveStatuteAlias,
  type StatuteAliasTarget,
} from "./statute-aliases";
import {
  CZE_CASE_LAW_REPORTER_TAIL_RE,
  STATUTE_GAZETTES,
} from "./statute-gazette";
import {
  STATUTE_QUERY_CAPABILITIES,
  type StatuteQueryCountry,
} from "./statute-query-capability";

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
  foldToAscii(normalizeUnicode(raw, "NFKC"))
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

/** `Sb.`, `Z. z.`, `Ú.l. I` → `sb`, `zz`, `ul`: dots, spaces and series dropped. */
const canonicalCollectionAbbreviation = (suffix: string): string =>
  suffix.replace(/ i{1,2}$/u, "").replaceAll(/[.\s]/gu, "");

const collectionsByAbbreviation = (
  gazettes: Readonly<
    Record<string, readonly { readonly abbreviation: string }[]>
  >,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(gazettes).flatMap(([eliCollection, spellings]) =>
      spellings.map(({ abbreviation }) => [
        canonicalCollectionAbbreviation(foldStatuteQuery(abbreviation)),
        eliCollection,
      ]),
    ),
  );

/**
 * Publisher collections as lawyers abbreviate them, mapped to the collection
 * segment of the publisher's ELI. The ambiguous historical Czech official
 * gazette (`Ú. l.`) is unsupported rather than widened across collections.
 */
const COLLECTION_BY_ABBREVIATION = {
  cze: collectionsByAbbreviation(STATUTE_GAZETTES.cze),
  svk: collectionsByAbbreviation(STATUTE_GAZETTES.svk),
} satisfies Record<StatuteQueryCountry, Readonly<Record<string, string>>>;

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

const ACT_NUMBER_SHAPE = String.raw`(\d{1,5}) ?/ ?(\d{4})(?: ?(sb\.?(?: ?m\.? ?s\.?)?|zb\.?|z\. ?z\.?|u\. ?l\.(?: i{1,2})?))?`;
const ACT_NUMBER_RE = new RegExp(`^${ACT_NUMBER_SHAPE}$`, "u");

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
  country: StatuteQueryCountry,
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
  const collections = COLLECTION_BY_ABBREVIATION[country];
  let collection: string | null =
    STATUTE_QUERY_CAPABILITIES[country].defaultCollection;
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
  country: StatuteQueryCountry,
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
  country: StatuteQueryCountry,
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

/** One act mentioned in a query, independent of the publisher's title text. */
export type StatuteQueryReference = {
  country: StatuteQueryCountry;
  collection: string | null;
  number: string;
  year: string;
  label: string | null;
};

// Ordinary words and clipped titles remain box-only aliases. Abbreviations
// embedded in prose must retain their conventional casing to avoid word pins.
const EMBEDDED_ALIAS_POLICY = {
  cze: {
    oz: ["OZ"],
    noz: ["NOZ"],
    obcz: ["ObčZ", "OBČZ", "OBCZ"],
    zok: ["ZOK"],
    zp: ["ZP"],
    tz: ["TZ"],
    trz: ["TrZ", "TRZ"],
    tr: ["TR"],
    osr: ["OSŘ", "OSR"],
    srs: ["SŘS", "SRS"],
    sr: "whole-query",
    insz: ["InsZ", "INSZ"],
    iz: ["IZ"],
    zdp: ["ZDP"],
    dph: ["DPH"],
    lzps: ["LZPS"],
    zrs: ["ZŘS", "ZRS"],
    "obc. zak.": "whole-query",
    "obc zak": "whole-query",
    obcansky: "whole-query",
    obcan: "whole-query",
    ustava: "whole-query",
    listina: "whole-query",
    "obcansky zakonik": "title",
    "zakon o obchodnich korporacich": "title",
    "zakonik prace": "title",
    "trestni zakonik": "title",
    "trestni rad": "title",
    "obcansky soudni rad": "title",
    "soudni rad spravni": "title",
    "spravni rad": "title",
    "insolvencni zakon": "title",
    "zivnostensky zakon": "title",
    "stavebni zakon": "title",
  },
  svk: {
    oz: ["OZ"],
    obchz: ["ObchZ", "OBCHZ"],
    obz: ["ObZ", "OBZ"],
    zp: ["ZP"],
    tz: ["TZ"],
    csp: ["CSP"],
    "obciansky zakonnik": "title",
    "obchodny zakonnik": "title",
    "zakonnik prace": "title",
    "trestny zakon": "title",
    "civilny sporovy poriadok": "title",
    "spravny poriadok": "title",
  },
} as const satisfies {
  [Country in StatuteQueryCountry]: {
    [Alias in keyof (typeof STATUTE_ALIASES)[Country]]:
      | "whole-query"
      | "title"
      | readonly string[];
  };
};

const WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

/**
 * Uses the box parser's number grammar and alias owner inside longer text.
 * Each Work identity appears once, in mention order; a collection belonging
 * to another jurisdiction never widens to a collection-less reference.
 */
export const readStatuteQueryReferences = (
  country: StatuteQueryCountry,
  raw: string,
): StatuteQueryReference[] => {
  const folded = foldStatuteQuery(raw);
  const casePreserved = foldToAscii(normalizeUnicode(raw, "NFKC"))
    .replace(/\s+/gu, " ")
    .trim();
  const wholeQuery = parseStatuteQuery(country, raw);
  if (wholeQuery.type === "act") {
    return [
      {
        country,
        collection: wholeQuery.collection,
        number: wholeQuery.number,
        year: wholeQuery.year,
        label: wholeQuery.label,
      },
    ];
  }
  const mentions: {
    offset: number;
    end: number;
    reference: StatuteQueryReference;
  }[] = [];
  const numberMentions = new RegExp(
    String.raw`(?<![\p{L}\p{N}/])${ACT_NUMBER_SHAPE}(?![\p{L}\p{N}/])`,
    "gu",
  );
  for (const match of folded.matchAll(numberMentions)) {
    const after = folded.slice(match.index + match[0].length);
    const before = folded.slice(0, match.index);
    // Docket register references and temporal "od" references are not acts,
    // even when surrounding text happens to include a gazette abbreviation.
    const docketOrDate =
      /(?:^|[^\p{L}\p{N}])(?:cdo|tdo|nd|odo|as|ads|afs|azs|ao|na|n|co|to|od) (?:c\. ?)?$/u.test(
        before,
      );
    const explicitPrefix = /(?:^|[^\p{L}\p{N}])c\. ?$/u.test(before);
    if (
      docketOrDate ||
      (match[3] === undefined && !explicitPrefix) ||
      CZE_CASE_LAW_REPORTER_TAIL_RE.test(after)
    ) {
      continue;
    }
    const intent = actFromNumber(country, match[0], null);
    if (intent?.type === "act") {
      mentions.push({
        offset: match.index,
        end: match.index + match[0].length,
        reference: {
          country,
          collection: intent.collection,
          number: intent.number,
          year: intent.year,
          label: intent.label,
        },
      });
    }
  }
  for (const [alias, target] of Object.entries(STATUTE_ALIASES[country])) {
    const policies: Record<
      string,
      "whole-query" | "title" | readonly string[]
    > = EMBEDDED_ALIAS_POLICY[country];
    const policy = policies[alias];
    if (policy === undefined) {
      panic("Statute alias is missing its embedded-match policy");
    }
    if (policy === "whole-query") {
      continue;
    }
    let offset = folded.indexOf(alias);
    while (offset !== -1) {
      const end = offset + alias.length;
      const originalSpelling = casePreserved.slice(offset, end);
      if (
        !WORD_CHARACTER.test(folded.charAt(offset - 1)) &&
        !WORD_CHARACTER.test(folded.charAt(end)) &&
        (policy === "title" ||
          policy.some((spelling) => foldToAscii(spelling) === originalSpelling))
      ) {
        mentions.push({ offset, end, reference: { country, ...target } });
      }
      offset = folded.indexOf(alias, end);
    }
  }
  const seen = new Set<string>();
  let consumedUntil = 0;
  return mentions
    .toSorted(
      (left, right) => left.offset - right.offset || right.end - left.end,
    )
    .flatMap(({ offset, end, reference }) => {
      // A complete alias wins over a shorter one inside it (občanský soudní řád vs občanský).
      if (offset < consumedUntil) {
        return [];
      }
      consumedUntil = end;
      const key = JSON.stringify([
        reference.collection,
        reference.year,
        reference.number,
      ]);
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [reference];
    });
};
