import type { createFormatter } from "use-intl/core";

import { US_WRITABLE_COURTS } from "@stll/api-contract/us-court-enrollment";
import type { UsWritableCourtId } from "@stll/api-contract/us-court-enrollment";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import { parsePlainDate, Temporal } from "@stll/time";

import { fromCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import { parseDeterministicDate } from "@/lib/deterministic-date";

type IntlFormatter = ReturnType<typeof createFormatter>;

/**
 * Jurisdiction-conventional citation of one decision, for the reader's
 * legal copy modes. The convention follows the COURT's jurisdiction, never
 * the UI language: a Czech decision is cited in Czech form everywhere.
 *
 * v1 limits, deliberate: pincites are emitted only where the convention
 * uses reporter pages (USA); paragraph-number pincites (EU, CZ "bod N")
 * need the block's ¶ number threaded through and come later. Czech and
 * Slovak court names are inflected to the genitive by a suffix rule that
 * covers the standing court names; an unrecognized name passes through
 * unchanged rather than guessing.
 */

export type CitationInput = {
  caseNumber: string;
  /** What `caseNumber` is: a docket, or a reporter or neutral citation. */
  caseNumberType: DecisionPrimaryReferenceType;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionType: string | null;
  ecli: string | null;
  /** Citable case name where the tradition uses one (USA, EU). */
  name: string | null;
  /** Reporter page the quotation starts on (USA convention only). */
  pincite: string | null;
};

export const parseDecisionDate = (
  value: Date | string | null,
): Temporal.PlainDate | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    const plainDate = parsePlainDate(value);
    if (plainDate !== null) {
      return plainDate;
    }
  }
  const instantDate = parseDeterministicDate(value);
  return instantDate === null
    ? null
    : Temporal.Instant.fromEpochMilliseconds(instantDate.getTime())
        .toZonedDateTimeISO("UTC")
        .toPlainDate();
};

/**
 * A calendar year as the reader's locale writes it, never grouped: a year is
 * an identifier rather than a quantity, so "2 020" is wrong everywhere, while
 * Eastern Arabic-Indic digits are right in the locales that use them. Without
 * this a chart shows its counts in one numbering system and its axis in
 * another.
 */
export const formatYear = (format: IntlFormatter, year: number): string =>
  format.number(year, { useGrouping: false });

/** The calendar year a decision was handed down; null when undated. */
export const decisionYear = (value: string | null): number | null =>
  parseDecisionDate(value)?.year ?? null;

/** "17. 5. 1954" — Czech and Slovak legal writing. */
const dottedDate = (date: Temporal.PlainDate): string =>
  `${String(date.day)}. ${String(date.month)}. ${String(date.year)}`;

/**
 * Czech/Slovak genitive of a court name: leading adjectives take the
 * genitive ending and the head noun "soud"/"súd" becomes "soudu"/"súdu";
 * everything after the head noun (e.g. "v Praze") is already invariant.
 */
const COURT_GENITIVE_SUFFIXES: readonly (readonly [string, string])[] = [
  ["ší", "šího"],
  ["ný", "ného"],
  ["ní", "ního"],
  ["ký", "kého"],
  ["ší", "šieho"],
];

const genitiveCourt = (court: string, language: "cs" | "sk"): string => {
  const words = court.split(" ");
  const headIndex = words.findIndex(
    (word) => word === "soud" || word === "súd",
  );
  if (headIndex === -1) {
    return court;
  }
  const inflected = words.map((word, index) => {
    if (index === headIndex) {
      return word === "soud" ? "soudu" : "súdu";
    }
    if (index > headIndex) {
      return word;
    }
    if (language === "sk") {
      if (word.endsWith("ší")) {
        return `${word.slice(0, -2)}šieho`;
      }
      if (word.endsWith("ý")) {
        return `${word.slice(0, -1)}ého`;
      }
      return word;
    }
    for (const [suffix, replacement] of COURT_GENITIVE_SUFFIXES) {
      if (word.endsWith(suffix)) {
        return `${word.slice(0, -suffix.length)}${replacement}`;
      }
    }
    return word;
  });
  return inflected.join(" ");
};

const czechCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "rozhodnutí";
  const court = genitiveCourt(input.court, "cs");
  const date = parseDecisionDate(input.decisionDate);
  const dated = date === null ? "" : ` ze dne ${dottedDate(date)}`;
  return `${type} ${court}${dated}, sp. zn. ${input.caseNumber}`;
};

const slovakCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "rozhodnutie";
  const court = genitiveCourt(input.court, "sk");
  const date = parseDecisionDate(input.decisionDate);
  const dated = date === null ? "" : ` zo dňa ${dottedDate(date)}`;
  return `${type} ${court}${dated}, sp. zn. ${input.caseNumber}`;
};

/**
 * Polish month names in the genitive, as a date inside a citation reads
 * ("z dnia 17 maja 1954 r."). A fixed table, not a locale formatter: the
 * convention belongs to the court, not to the reader's locale settings.
 */
const POLISH_GENITIVE_MONTHS = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
] as const;

/**
 * Polish genitive of a court name: the head noun and its adjectives inflect
 * ("Sąd Apelacyjny w Łodzi" → "Sądu Apelacyjnego w Łodzi"), while the
 * locality after a preposition stays. All-or-nothing: if any word before
 * the preposition falls outside the known patterns, the nominative passes
 * through unchanged rather than half-inflected.
 */
const POLISH_PREPOSITION_RE = /^(?:w|we|dla)$/u;

const polishGenitiveWord = (word: string): string | null => {
  if (word === "Sąd") {
    return "Sądu";
  }
  if (word === "Trybunał") {
    return "Trybunału";
  }
  if (word.endsWith("ni") || word.endsWith("ki")) {
    return `${word.slice(0, -1)}iego`;
  }
  if (word.endsWith("y")) {
    return `${word.slice(0, -1)}ego`;
  }
  return null;
};

const polishGenitiveCourt = (court: string): string => {
  const words = court.split(" ");
  const inflected: string[] = [];
  for (const [index, word] of words.entries()) {
    if (POLISH_PREPOSITION_RE.test(word)) {
      inflected.push(...words.slice(index));
      return inflected.join(" ");
    }
    const genitive = polishGenitiveWord(word);
    if (genitive === null) {
      return court;
    }
    inflected.push(genitive);
  }
  return inflected.join(" ");
};

const polishCitation = (input: CitationInput): string => {
  const type = input.decisionType ?? "orzeczenie";
  const date = parseDecisionDate(input.decisionDate);
  const month = date === null ? null : POLISH_GENITIVE_MONTHS[date.month - 1];
  const dated =
    date === null || month === undefined || month === null
      ? ""
      : ` z dnia ${String(date.day)} ${month} ${String(date.year)} r.`;
  return `${type} ${polishGenitiveCourt(input.court)}${dated}, sygn. akt ${input.caseNumber}`;
};

const austrianCitation = (input: CitationInput): string => {
  const date = parseDecisionDate(input.decisionDate);
  const dated =
    date === null
      ? ""
      : ` ${String(date.day)}. ${String(date.month)}. ${String(date.year)},`;
  return `${input.court}${dated} ${input.caseNumber}`;
};

const euCitation = (input: CitationInput): string => {
  const named = input.name === null ? "" : `${input.name}, `;
  const ecli = input.ecli === null ? "" : `, ${input.ecli}`;
  return `${named}${input.caseNumber}${ecli}`;
};

/**
 * IndigoBook month abbreviations. A fixed table, not a locale formatter: the
 * convention belongs to the court, not to the reader's locale settings.
 */
const INDIGOBOOK_MONTHS = [
  "Jan.",
  "Feb.",
  "Mar.",
  "Apr.",
  "May",
  "June",
  "July",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec.",
] as const;

/**
 * The IndigoBook court abbreviation of each writable court. Total over the
 * writable courts, so enrolling a court cannot compile without deciding its
 * form.
 */
const US_COURT_INDIGOBOOK_ABBREVIATIONS = {
  scotus: "U.S.",
} as const satisfies Record<UsWritableCourtId, string>;

const WRITABLE_COURT_BY_NAME: ReadonlyMap<string, UsWritableCourtId> = new Map(
  US_WRITABLE_COURTS.map(({ canonicalName, id }) => [canonicalName, id]),
);

/**
 * A USA decision is stored under its enrolled court's canonical name, so the
 * name finds the abbreviation; any other name is cited as it stands.
 */
const usCourtAbbreviation = (court: string): string => {
  const enrolled = WRITABLE_COURT_BY_NAME.get(court);
  return enrolled === undefined
    ? court
    : US_COURT_INDIGOBOOK_ABBREVIATIONS[enrolled];
};

const DOCKET_PREFIX_RE = /^Nos?\.\s/u;

/**
 * A decision known only by its docket, cited as a slip opinion:
 * "Name, No. 17-1618 (U.S. June 15, 2020)". The pincite is left out: the
 * reader's page markers are not known to be slip-opinion pages, and a
 * reporter page cited as "slip op. at N" would point at the wrong text.
 */
const usDocketCitation = (input: CitationInput): string => {
  const docket = DOCKET_PREFIX_RE.test(input.caseNumber)
    ? input.caseNumber
    : `No. ${input.caseNumber}`;
  const named = input.name === null ? docket : `${input.name}, ${docket}`;
  const court = usCourtAbbreviation(input.court);
  const date = parseDecisionDate(input.decisionDate);
  const month = date === null ? undefined : INDIGOBOOK_MONTHS[date.month - 1];
  const dated =
    date === null || month === undefined
      ? ""
      : ` ${month} ${String(date.day)}, ${String(date.year)}`;
  return `${named} (${court}${dated})`;
};

const usCitation = (input: CitationInput): string => {
  if (input.caseNumberType === DECISION_IDENTIFIER_TYPES.CASE_NUMBER) {
    return usDocketCitation(input);
  }
  const cite =
    input.pincite === null
      ? input.caseNumber
      : `${input.caseNumber}, ${input.pincite}`;
  const named = input.name === null ? cite : `${input.name}, ${cite}`;
  const date = parseDecisionDate(input.decisionDate);
  return date === null ? named : `${named} (${String(date.year)})`;
};

const genericCitation = (input: CitationInput): string => {
  const named = input.name === null ? "" : `${input.name}, `;
  const date = parseDecisionDate(input.decisionDate);
  const dated = date === null ? "" : ` (${String(date.year)})`;
  return `${named}${input.court}, ${input.caseNumber}${dated}`;
};

const CITATION_FORMATTERS: Record<string, (input: CitationInput) => string> = {
  AUT: austrianCitation,
  CZE: czechCitation,
  EU: euCitation,
  POL: polishCitation,
  SVK: slovakCitation,
  USA: usCitation,
};

export const formatDecisionCitation = (input: CitationInput): string =>
  (
    CITATION_FORMATTERS[fromCaseLawCountryParam(input.country)] ??
    genericCitation
  )(input);
