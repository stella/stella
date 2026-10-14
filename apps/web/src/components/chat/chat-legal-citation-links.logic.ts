import { Temporal, todayFor } from "@stll/time";

import type { LegalCitationLinkPair } from "@/components/chat/rehype-legal-citation-links";

/** The UI languages whose own jurisdiction reads a bare `§ 52 ZP`. */
const COUNTRY_BY_UI_LANGUAGE: Readonly<Record<string, string>> = {
  cs: "CZE",
  sk: "SVK",
};

/** As many jurisdictions as the server reads an answer against. */
const CITATION_COUNTRIES_MAX = 4;

type PracticeJurisdiction = { countryCode: string; isPrimary: boolean };

/**
 * The jurisdictions an answer's citations are read against, most likely
 * first: the organization's practice jurisdictions, primary first; without
 * any, the jurisdiction of the UI language. Empty when neither names one, so
 * nothing is linked rather than read against a guess.
 */
export const chatCitationCountries = ({
  locale,
  practiceJurisdictions,
}: {
  locale: string;
  practiceJurisdictions: readonly PracticeJurisdiction[];
}): string[] => {
  const practice = practiceJurisdictions
    .toSorted((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
    .map(({ countryCode }) => countryCode);
  if (practice.length > 0) {
    return [...new Set(practice)].slice(0, CITATION_COUNTRIES_MAX);
  }
  const language = locale.split("-")[0]?.toLowerCase() ?? "";
  const fallback = COUNTRY_BY_UI_LANGUAGE[language];
  return fallback === undefined ? [] : [fallback];
};

/**
 * The day an answer was written, in the reader's zone, as the server reads
 * `asOf`. A hydrated message can carry its timestamp as text; one that
 * carries none, or an unreadable one, is being written now.
 */
export const chatCitationAsOf = ({
  createdAt,
  now,
  timeZone,
}: {
  createdAt: Date | string | undefined;
  now: Date;
  timeZone: string;
}): string => {
  const written = createdAt === undefined ? now : new Date(createdAt);
  const at = Number.isNaN(written.getTime()) ? now : written;
  return todayFor(
    timeZone,
    Temporal.Instant.fromEpochMilliseconds(at.getTime()),
  ).toString();
};

/** A large prime below 2^31, so the running hash stays a safe integer. */
const TEXT_KEY_MODULUS = 2_147_483_647;
const TEXT_KEY_BASE = 31;

/** A short, stable key for an answer's text: its length and a polynomial hash. */
export const chatCitationTextKey = (text: string): string => {
  let hash = 0;
  for (const character of text) {
    hash =
      (hash * TEXT_KEY_BASE + (character.codePointAt(0) ?? 0)) %
      TEXT_KEY_MODULUS;
  }
  return `${String(text.length)}:${hash.toString(36)}`;
};

/** The text an answer's parts render, in order, as the server reads it. */
export const chatCitationAnswerText = (parts: readonly string[]): string =>
  parts.join("\n\n");

/**
 * The citations the server linked, by the words each covers. One spelling
 * opens one page: the same words cited twice on one date resolve alike.
 */
export const chatCitationLinkPairs = (
  text: string,
  links: readonly { start: number; end: number; url: string }[],
): LegalCitationLinkPair[] => {
  const urlByText = new Map<string, string>();
  for (const { start, end, url } of links) {
    const cited = text.slice(start, end);
    if (cited.trim() !== "" && !urlByText.has(cited)) {
      urlByText.set(cited, url);
    }
  }
  return [...urlByText].map(([cited, url]) => ({ text: cited, url }));
};
