import { DETECTION_SOURCES } from "../types";
import type { Entity } from "../types";

type PiiPattern = {
  label: string;
  pattern: RegExp;
  score?: number;
};

const MIN_PHONE_LENGTH = 7;

/**
 * Czech and Central European academic/professional titles.
 * When followed by capitalized words, these are near-certain
 * person name indicators.
 *
 * Covers: law (JUDr., Mgr.), medicine (MUDr., MVDr.),
 * engineering (Ing.), education (PaedDr., PhDr., RNDr.),
 * theology (ThDr., ThLic.), and post-nominal (Ph.D., CSc.,
 * MBA, etc.). Also common German/international titles.
 */
const TITLE_PREFIX = [
  // Czech pre-nominal (case-sensitive abbreviations)
  "Ing\\.",
  "Mgr\\.",
  "Bc\\.",
  "JUDr\\.",
  "MUDr\\.",
  "MVDr\\.",
  "PhDr\\.",
  "RNDr\\.",
  "PaedDr\\.",
  "ThDr\\.",
  "ThLic\\.",
  "ICDr\\.",
  "RSDr\\.",
  "doc\\.",
  "prof\\.",
  // German/international
  "Dr\\.",
  "Dr\\.\\s*med\\.",
  "Dr\\.\\s*jur\\.",
  "Dr\\.\\s*rer\\.\\s*nat\\.",
  "Dr\\.\\s*phil\\.",
  "Dr\\.\\s*Ing\\.",
  "Dipl\\.\\s*Ing\\.",
  "Dipl\\.-Ing\\.",
  "RA",
  "Mag\\.",
  "Univ\\.\\s*Prof\\.",
].join("|");

/**
 * Post-nominal degrees (comma or space separated after name).
 * These extend a match when they appear after the name words.
 */
const POST_NOMINAL = [
  "Ph\\.D\\.",
  "CSc\\.",
  "DrSc\\.",
  "MBA",
  "MPA",
  "LL\\.M\\.",
  "LL\\.B\\.",
  "MSc\\.",
  "BSc\\.",
  "M\\.A\\.",
  "B\\.A\\.",
  "DiS\\.",
].join("|");

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

const TITLED_PERSON_RE = new RegExp(
  `(?:${TITLE_PREFIX})` +
    `(?:\\s+(?:${TITLE_PREFIX}))*` +
    "\\s+" +
    `(?:${NAME_WORD})` +
    `(?:\\s{1,4}${NAME_WORD}){1,3}` +
    `(?:,?\\s+(?:${POST_NOMINAL}))?`,
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
  {
    label: "ip address",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
];

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

  return results;
};
