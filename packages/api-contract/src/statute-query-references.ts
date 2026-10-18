import { panic } from "better-result";

import { AhoCorasick } from "@stll/aho-corasick";
import { normalizeUnicode, foldToAscii } from "@stll/text-normalize";

import { STATUTE_ALIASES, type StatuteAliasTarget } from "./statute-aliases";
import { CZE_CASE_LAW_REPORTER_TAIL_RE } from "./statute-gazette";
import type { StatuteQueryCountry } from "./statute-query-capability";
import { foldStatuteQuery, parseStatuteQuery } from "./statute-query-intent";
import { STATUTE_ACT_NUMBER_SHAPE } from "./statute-query-number-pattern";

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

const embeddedAliasesFor = (country: StatuteQueryCountry): string[] => {
  const policies: Record<string, "whole-query" | "title" | readonly string[]> =
    EMBEDDED_ALIAS_POLICY[country];
  return Object.keys(STATUTE_ALIASES[country]).filter((alias) => {
    const policy = policies[alias];
    if (policy === undefined) {
      return panic("Statute alias is missing its embedded-match policy");
    }
    return policy !== "whole-query";
  });
};

const EMBEDDED_ALIASES = {
  cze: embeddedAliasesFor("cze"),
  svk: embeddedAliasesFor("svk"),
} satisfies Record<StatuteQueryCountry, string[]>;

const EMBEDDED_ALIAS_MATCHERS = {
  cze: new AhoCorasick(EMBEDDED_ALIASES.cze),
  svk: new AhoCorasick(EMBEDDED_ALIASES.svk),
} satisfies Record<StatuteQueryCountry, AhoCorasick>;

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
    String.raw`(?<![\p{L}\p{N}/])${STATUTE_ACT_NUMBER_SHAPE}(?![\p{L}\p{N}/])`,
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
    const intent = parseStatuteQuery(country, match[0]);
    if (intent.type === "act") {
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
  const aliasMatches =
    EMBEDDED_ALIAS_MATCHERS[country].findOverlappingIter(folded);
  const matchesByAlias = new Map<number, typeof aliasMatches>();
  for (const match of aliasMatches) {
    const matches = matchesByAlias.get(match.pattern);
    if (matches === undefined) {
      matchesByAlias.set(match.pattern, [match]);
      continue;
    }
    matches.push(match);
  }
  const aliasTargets: Readonly<Record<string, StatuteAliasTarget | undefined>> =
    STATUTE_ALIASES[country];
  for (const [pattern, alias] of EMBEDDED_ALIASES[country].entries()) {
    const target = aliasTargets[alias];
    if (target === undefined) {
      return panic(`Embedded statute alias is missing: ${alias}`);
    }
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
    let nextOffset = 0;
    for (const { start: offset, end } of matchesByAlias.get(pattern) ?? []) {
      if (offset < nextOffset) {
        continue;
      }
      nextOffset = end;
      const originalSpelling = casePreserved.slice(offset, end);
      if (
        !WORD_CHARACTER.test(folded.charAt(offset - 1)) &&
        !WORD_CHARACTER.test(folded.charAt(end)) &&
        (policy === "title" ||
          policy.some((spelling) => foldToAscii(spelling) === originalSpelling))
      ) {
        mentions.push({ offset, end, reference: { country, ...target } });
      }
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
