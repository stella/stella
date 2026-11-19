import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import {
  canonicalCzNsCollectionCitation,
  type CzNsCollectionPart,
  parseCzNsCollectionCitation,
} from "./cz-ns-collection-citation";
import { foldDecisionIdentifierInput } from "./decision-docket-grammar";
import type { DecisionReporterGrammar } from "./decision-query-intent";
import {
  readsUsReporterCitations,
  US_REPORTER_GRAMMAR,
} from "./us-reporter-citation";

/** The printed NSS citation embedded in publisher labels and read as a whole entry in search. */
export const CZ_NSS_REPORTER_SOURCE = String.raw`[čc]\.\s*([1-9]\d{0,4})\s*\/\s*(\d{4})\s+Sb\.\s*NSS(?![\p{L}\d])`;

const NSS_ENTRY = new RegExp(`^${CZ_NSS_REPORTER_SOURCE}$`, "iu");
/** A matched named group required by the pattern's own contract. */
const requiredGroup = (
  groups: Partial<Record<string, string>>,
  name: string,
): string =>
  groups[name] ?? panic(`Matched constitutional citation has no ${name}`);

const CZ_US_GAZETTE_RE = /^(?<number>\d{1,4})\/(?<year>\d{4}) Sb\.?$/u;
const CZ_US_REPORT_RE =
  /^(?<kind>[NU]) ?(?<number>\d{1,4})\/(?<volume>\d{1,3}) SbNU(?: \d{1,4})?$/u;
const CZ_US_REPORT_VOLUME_RE =
  /^(?:Sbír\p{L}{1,2} nálezů a usnesení(?: \S+(?: soudu)?)? ?,? ?)?(?:svaz\p{L}{2}|sv\.) ?(?<volume>\d{1,3}) ?, ?(?<kind>nález|usnesení) [čc]\. ?(?<number>\d{1,4})$/u;

/**
 * A Constitutional Court ruling in one spelling per publication, for the
 * reporter-citation normalization, or null for text that is neither: the
 * gazette number as `234/2002 Sb.`, the reporter entry as `SbNU sv. 26 N 53`.
 *
 * The reporter entry keeps volume, series and number and drops the page: the
 * three name the entry, the page only locates it, and a citation that leaves
 * the page out still names the same ruling. Letters stand between the numbers
 * because the shared normalization strips punctuation, and `N 5/326` must not
 * meet `N 53/26`.
 */
export const czechConstitutionalDesignation = (
  value: string,
): string | null => {
  const text = normalizeUnicode(value, "NFC")
    .replace(/\s+/gu, " ")
    .replace(/ ?\/ ?/gu, "/")
    .trim();
  const gazette = CZ_US_GAZETTE_RE.exec(text)?.groups;
  if (gazette !== undefined) {
    return `${requiredGroup(gazette, "number")}/${requiredGroup(gazette, "year")} Sb.`;
  }
  const report =
    CZ_US_REPORT_RE.exec(text)?.groups ??
    CZ_US_REPORT_VOLUME_RE.exec(text)?.groups;
  if (report === undefined) {
    return null;
  }
  const kind = requiredGroup(report, "kind");
  const series = kind === "U" || kind === "usnesení" ? "U" : "N";
  const volume = Number(requiredGroup(report, "volume"));
  const number = Number(requiredGroup(report, "number"));
  return `SbNU sv. ${String(volume)} ${series} ${String(number)}`;
};

const CZ_US_CANONICAL_REPORT_RE =
  /^SbNU sv\. (?:0|[1-9]\d{0,2}) [NU] (?:0|[1-9]\d{0,3})$/u;

const CZECH_COLLECTIONS: DecisionReporterGrammar = {
  canonicalCitation: (text) => {
    const constitutional = czechConstitutionalDesignation(text);
    if (constitutional?.startsWith("SbNU ")) {
      return constitutional;
    }
    if (CZ_US_CANONICAL_REPORT_RE.test(text)) {
      return text;
    }
    const nss = NSS_ENTRY.exec(foldDecisionIdentifierInput(text));
    return nss === null
      ? canonicalCzNsCollectionCitation(text)
      : `č. ${nss[1]}/${nss[2]} Sb. NSS`;
  },
};

const LEGACY_CZ_NS_PART_SUFFIXES = {
  civil: ["ob", "obč"],
  criminal: ["tr"],
} as const satisfies Record<CzNsCollectionPart, readonly string[]>;

/** Spellings older typed rows stored before canonical collection keys. */
export const czechReporterLookupSpellings = (
  value: string,
): readonly string[] => {
  if (NSS_ENTRY.test(value)) {
    return [value, value.replace(/^č/iu, "c")];
  }
  const collection = parseCzNsCollectionCitation(value);
  if (collection === null) {
    return [value];
  }
  const suffixes =
    collection.part === null
      ? [""]
      : LEGACY_CZ_NS_PART_SUFFIXES[collection.part];
  return [
    value,
    ...suffixes.flatMap((suffix) =>
      ["č", "c"].map(
        (marker) =>
          `${marker}. ${String(collection.number)}/${String(collection.year)} Sb. rozh.${suffix.length === 0 ? "" : ` ${suffix}.`}`,
      ),
    ),
  ];
};

export const decisionReporterGrammarForJurisdiction = (
  jurisdiction: string | null | undefined,
): DecisionReporterGrammar | null => {
  if (readsUsReporterCitations(jurisdiction)) {
    return US_REPORTER_GRAMMAR;
  }
  return jurisdiction === "CZE" ? CZECH_COLLECTIONS : null;
};
