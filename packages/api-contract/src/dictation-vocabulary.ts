import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

import { MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH } from "./transcription";

/**
 * The organization's dictation words: names and terms every member's
 * dictation should spell the organization's way. Administrators keep one
 * list for the whole organization; the API picks the few that matter for
 * each dictation, so the list may be long.
 */

/** How many words one organization's list holds. */
export const MAX_ORGANIZATION_DICTATION_TERMS = 10_000;
/** A word's length in UTF-16 code units, the transcription limit. */
export const MAX_DICTATION_TERM_LENGTH =
  MAX_TRANSCRIPTION_VOCABULARY_TERM_LENGTH;
/** How many words one add, check or delete request carries; a longer
 *  import goes in several requests. */
export const MAX_DICTATION_TERMS_PER_REQUEST = 2000;

// Controls other than whitespace (which becomes a space), and the
// bidirectional controls and marks, which would reorder or hide text.
const REFUSED_CHARACTERS = /[\p{Cc}\p{Bidi_Control}]/u;
const WHITESPACE_RUN = /\s+/gu;

export type DictationTermReading =
  | { type: "term"; term: string; key: string }
  | { type: "blank" }
  | { type: "too-long" }
  | { type: "invalid" };

/** The key two spellings of one word share: lowercase, NFC. Diacritics stay,
 *  so "Novák" and "Novak" are two words. */
export const dictationTermKey = (term: string): string =>
  normalizeUnicode(term, "NFC").toLowerCase();

/**
 * One word as the list stores it: NFC, each run of whitespace one space,
 * trimmed. A blank line is nothing; a word longer than transcription
 * accepts, or one holding a control character, is refused.
 */
export const readDictationTerm = (raw: string): DictationTermReading => {
  const spaced = normalizeUnicode(raw, "NFC")
    .replaceAll(WHITESPACE_RUN, " ")
    .trim();
  if (spaced.length === 0) {
    return { type: "blank" };
  }
  if (REFUSED_CHARACTERS.test(spaced)) {
    return { type: "invalid" };
  }
  if (spaced.length > MAX_DICTATION_TERM_LENGTH) {
    return { type: "too-long" };
  }
  return { type: "term", term: spaced, key: dictationTermKey(spaced) };
};

/** A stored word as a request schema checks it. */
export const isStoredDictationTerm = (raw: string): boolean => {
  const reading = readDictationTerm(raw);
  return reading.type === "term" && reading.term === raw;
};

export type DictationTermImport = {
  /** Each new word once, in the order it came. */
  terms: { term: string; key: string }[];
  /** Lines that repeat a word already in the import. */
  repeated: number;
  tooLong: number;
  invalid: number;
};

/** Words an import names, each once by its key; blank lines are skipped. */
export const readDictationTermImport = (
  lines: readonly string[],
): DictationTermImport => {
  const seen = new Map<string, string>();
  let repeated = 0;
  let tooLong = 0;
  let invalid = 0;
  for (const line of lines) {
    const reading = readDictationTerm(line);
    switch (reading.type) {
      case "blank":
        break;
      case "too-long":
        tooLong += 1;
        break;
      case "invalid":
        invalid += 1;
        break;
      case "term":
        if (seen.has(reading.key)) {
          repeated += 1;
        } else {
          seen.set(reading.key, reading.term);
        }
        break;
      default:
        reading satisfies never;
        return panic("Unknown dictation word reading");
    }
  }
  return {
    terms: [...seen].map(([key, term]) => ({ term, key })),
    repeated,
    tooLong,
    invalid,
  };
};

/**
 * The lines of a pasted list or an imported file. A CSV file gives the
 * first cell of each row (quotes allowed, so a word may hold a comma);
 * anything else gives one word per line.
 */
export const dictationImportLines = (
  text: string,
  format: "lines" | "csv",
): string[] => {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
  return format === "csv" ? lines.map(firstCsvCell) : lines;
};

const firstCsvCell = (line: string): string => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('"')) {
    const end = line.search(/[,;\t]/u);
    return end === -1 ? line : line.slice(0, end);
  }
  let cell = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === '"') {
      if (trimmed[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      return cell;
    }
    cell += character;
  }
  return cell;
};
