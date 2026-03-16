import { POST_NOMINALS, TITLE_PREFIXES } from "../config/titles";
import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

type PiiPattern = {
  label: string;
  pattern: RegExp;
  score?: number;
};

const MIN_PHONE_LENGTH = 7;

/**
 * Escape a plain-text title for use in a regex alternation.
 * Dots become `\.`, spaces become `\s*`, and other
 * regex-special characters are escaped literally.
 */
const escapeTitle = (title: string): string =>
  title
    // eslint-disable-next-line no-useless-escape
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");

const TITLE_PREFIX = TITLE_PREFIXES.toSorted((a, b) => b.length - a.length)
  .map(escapeTitle)
  .join("|");

const POST_NOMINAL = POST_NOMINALS.toSorted((a, b) => b.length - a.length)
  .map(escapeTitle)
  .join("|");

/**
 * Match title + 2-4 capitalized words, optionally followed
 * by a post-nominal degree. The title acts as a high-
 * confidence signal that the following words are a person
 * name.
 *
 * Examples:
 *   "Ing. Jan Novak" -> person
 *   "JUDr. Jarmila Bacova, Ph.D." -> person
 *   "prof. MUDr. Karel Valdauf" -> person (stacked titles)
 *   "Dr. med. Heinrich Muller" -> person
 */
// Character classes for Czech/German diacritics in names
// biome-ignore lint/security/noSecrets: diacritics char class, not a secret
const UPPER_CZ = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ";
// biome-ignore lint/security/noSecrets: diacritics char class, not a secret
const LOWER_CZ = "a-záčďéěíňóřšťúůýžäöüß";
const NAME_WORD = `[${UPPER_CZ}][${LOWER_CZ}]+`;

/**
 * Patronymic and nobiliary particles common in European
 * names (von, van, de, di, etc.). Optional between name
 * words so "Ludwig van Beethoven" matches correctly.
 */
// Sorted longest-first to prevent partial matches
const PARTICLE =
  `(?:van der|van den|de la|della|` +
  `von|van|dos|ibn|ben|bin|del|zum|zur|ten|ter|` +
  `da|de|di|al|el|le|la|zu|af|av)`;

const TITLED_PERSON_RE = new RegExp(
  `(?:${TITLE_PREFIX})` +
    `(?:\\s+(?:${TITLE_PREFIX}))*` +
    "\\s+" +
    `(?:${NAME_WORD})` +
    `(?:\\s{1,4}(?:${PARTICLE}\\s+)?${NAME_WORD}){1,3}` +
    `(?:,?\\s+(?:${POST_NOMINAL}))?`,
  "g",
);

/**
 * English honorific + name pattern.
 * Matches "Mr John Smith", "Dame Helena Kennedy QC",
 * "Mme Dupont", "Maître Leblanc", etc.
 */
const EN_NAME_WORD = `[A-Z][a-z]+`;
const EN_LEGAL_POST_NOMINAL = `(?:\\s+(?:QC|KC|SC|LJ|AG))?`;
const EN_HONORIFIC_PERSON_RE = new RegExp(
  `(?:\\bM\\.|Mrs|Ms|Miss|Messrs|Mr|Sir|Dame|Lord|Lady|` +
    `Judge|Justice|President|Mme|Mlle|\\bMe\\b|Maître)` +
    `\\.?\\s+${EN_NAME_WORD}` +
    `(?:[\\s-]{1,2}(?:${PARTICLE}\\s+)?` +
    `${EN_NAME_WORD}){0,3}${EN_LEGAL_POST_NOMINAL}`,
  "g",
);

/**
 * Regex-based PII detection for structured patterns.
 * Language-agnostic; complements the NER model (which
 * handles names, orgs, addresses better).
 *
 * All matches get score = 1.0 (deterministic) unless
 * overridden by the pattern.
 */
const PII_PATTERNS: readonly PiiPattern[] = [
  {
    label: "person",
    pattern: TITLED_PERSON_RE,
    score: 0.95,
  },
  {
    label: "person",
    pattern: EN_HONORIFIC_PERSON_RE,
    score: 0.95,
  },
  {
    label: "iban",
    pattern:
      /\b[A-Z]{2}\d{2}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{0,14}\b/g,
  },
  {
    label: "email address",
    pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  },
  {
    label: "phone number",
    pattern:
      /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{2,4}[\s.-]?\d{0,4}\b/g,
  },
  {
    label: "credit card number",
    pattern:
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2})[\s.-]?\d{4}[\s.-]?\d{4}[\s.-]?\d{2,4}\b/g,
  },
  {
    label: "czech birth number",
    pattern: /\b\d{6}\/\d{3,4}\b/g,
  },
  {
    label: "date",
    pattern: /\b(?:\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
  },
  // Czech spaced dates: "1. 1. 2025", "12. 3. 2024"
  {
    label: "date",
    pattern: /\b\d{1,2}\.\s+\d{1,2}\.\s+\d{4}\b/g,
  },
  // Czech written-out month dates: "1. ledna 2025"
  {
    label: "date",
    pattern:
      /\b\d{1,2}\.\s+(?:ledna|února|března|dubna|května|června|července|srpna|září|října|listopadu|prosince)\s+\d{4}\b/g,
  },
  // German written-out month dates: "1. Januar 2025"
  {
    label: "date",
    pattern:
      /\b\d{1,2}\.\s+(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4}\b/gi,
  },
  // English written-month dates: "13 July 1989", "3 February 2015"
  {
    label: "date",
    pattern:
      /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
  },
  // English month + year: "October 1983", "January 2024"
  {
    label: "date",
    pattern:
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/gi,
  },
  // Ordinal English dates: "1st January 2025", "23rd February"
  {
    label: "date",
    pattern:
      /\b\d{1,2}(?:st|nd|rd|th)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?\b/gi,
  },
  {
    label: "ip address",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  // Czech bank account: prefix-account/bank_code
  // e.g., "123-9787260287/0100", "826611/0100", "6034776349/0800"
  {
    label: "bank account number",
    pattern: /\b\d{1,6}-?\d{6,10}\/\d{4}\b/g,
    score: 0.95,
  },
];

// ── Company ID keyword patterns ──────────────────────
// Matches KEYWORD + separator + VALUE for registration
// numbers and tax IDs across European jurisdictions.
// Handles variable spacing: "IČ:", "IČ :", "IČO : ", etc.

type CompanyIdKeyword = {
  label: "registration number" | "tax identification number";
  keywords: readonly string[];
};

const COMPANY_ID_GROUPS: readonly CompanyIdKeyword[] = [
  {
    label: "registration number",
    keywords: [
      // Czech
      "IČO",
      "IČ",
      "identifikační číslo",
      "registrační číslo",
      // English
      "registration number",
      "company id",
      "company number",
      // German
      "Handelsregisternummer",
      "Handelsregister",
      "HRB",
      "Registernummer",
      // French
      "SIREN",
      "SIRET",
      // Italian
      "partita IVA",
      "codice fiscale",
      // Austrian/Swiss
      "UID",
    ],
  },
  {
    label: "tax identification number",
    keywords: [
      // Czech
      "DIČ",
      "daňové identifikační číslo",
      // English
      "VAT number",
      "VAT ID",
      "tax identification number",
      "tax id",
      // German
      "Steuernummer",
      "Steuer-Nr.",
      "USt-IdNr.",
      "USt-IdNr",
      // Polish
      "NIP",
      // Spanish
      "CIF",
      "NIF",
      // Dutch
      "BTW",
    ],
  },
];

const COMPANY_ID_SCORE = 0.95;

/**
 * Build a single regex per label group that matches any
 * keyword followed by a separator and a value. The value
 * pattern allows an optional country prefix (CZ, DE, etc.)
 * followed by digits with optional spaces/hyphens/slashes.
 *
 * Uses Unicode negative lookbehind to prevent partial
 * keyword matches (e.g., "IČ" inside "DIČ").
 */
const buildCompanyIdPatterns = (): PiiPattern[] => {
  const patterns: PiiPattern[] = [];
  for (const group of COMPANY_ID_GROUPS) {
    // Sort keywords longest-first so longer keywords
    // are tried before shorter prefixes (IČO before IČ).
    const sorted = group.keywords.toSorted((a, b) => b.length - a.length);
    const keywordAlt = sorted.map(escapeTitle).join("|");
    // Separator: colon with optional whitespace, OR required
    // whitespace (handles "IČ:", "IČ :", "IČO:12345678", "IČO 12345678")
    // Value: optional 0-4 letter prefix (country code or
    //   register prefix like HRB, CZ), then a digit, then
    //   4+ more digits/spaces/hyphens/slashes
    const re = new RegExp(
      `(?<!\\p{L})(?:${keywordAlt})(?:\\s*:\\s*|\\s+)` +
        `([A-Z]{0,4}\\s?\\d[\\d\\s\\-/]{4,})`,
      "giu",
    );
    patterns.push({
      label: group.label,
      pattern: re,
      score: COMPANY_ID_SCORE,
    });
  }
  return patterns;
};

const COMPANY_ID_PATTERNS = buildCompanyIdPatterns();

/**
 * Run regex-based PII detection on the full document text.
 * Returns entities with score = 1.0 (deterministic match)
 * and source = "regex".
 */
export const detectRegexPii = (fullText: string): Entity[] => {
  const results: Entity[] = [];

  for (const { label, pattern, score } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(fullText);
      match !== null;
      match = pattern.exec(fullText)
    ) {
      const text = match[0];
      if (label === "phone number" && text.length < MIN_PHONE_LENGTH) {
        continue;
      }
      results.push({
        start: match.index,
        end: match.index + text.length,
        label,
        text,
        score: score ?? 1,
        source: DETECTION_SOURCES.REGEX,
      });
    }
  }

  // Company ID keyword patterns: extract only the value
  // (capture group 1), not the keyword prefix.
  for (const { label, pattern, score } of COMPANY_ID_PATTERNS) {
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(fullText);
      match !== null;
      match = pattern.exec(fullText)
    ) {
      const value = match[1]?.trim();
      if (!value) {
        continue;
      }
      // Find value position from the END of the match (the
      // value is always the trailing capture group, so search
      // backwards to avoid matching inside the keyword)
      const valueIdx = match.index + match[0].lastIndexOf(value);
      results.push({
        start: valueIdx,
        end: valueIdx + value.length,
        label,
        text: value,
        score: score ?? 1,
        source: DETECTION_SOURCES.REGEX,
      });
    }
  }

  return results;
};
