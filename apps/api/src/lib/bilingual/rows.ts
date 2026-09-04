// Deterministic half of the bilingual pipeline: the row model derived from a
// bilingual DOCX, rule-stamped dispositions, glossary candidates found by
// pattern, and the consistency check applied to every translation.

import { panic } from "better-result";

import type { BilingualRow as FolioBilingualRow } from "@stll/folio-core/server";

import {
  BILINGUAL_LIMITS,
  BILINGUAL_ROW_DISPOSITION,
} from "@/api/lib/bilingual/contract";
import type {
  BilingualDispositionOrigin,
  BilingualGlossaryEntry,
  BilingualRowDisposition,
  BilingualRowKind,
  BilingualTableLayout,
} from "@/api/lib/bilingual/contract";

/** One translatable unit as the pipeline sees it, flattened from folio's
 *  manifest: a paragraph inside a kept table is its own row (`inTable`). */
export type BilingualUnit = {
  rowId: string;
  ordinal: number;
  kind: BilingualRowKind;
  inTable: boolean;
  tableLayout: BilingualTableLayout | null;
  sourceParaId: string | null;
  sourceText: string;
};

export type DispositionedUnit = BilingualUnit & {
  disposition: BilingualRowDisposition;
  dispositionOrigin: BilingualDispositionOrigin;
};

/** Stacked table rows keep distinct source and target paragraphs. Folio's
 * inline table layout addresses the source paragraph itself. */
export const hasSeparateTableTarget = (
  unit: Pick<BilingualUnit, "tableLayout">,
): boolean => unit.tableLayout === "stacked";

/** Flatten folio's manifest into units; rows without a usable handle or text
 *  beyond the limit are dropped, which the caller reports as a warning. */
export const flattenBilingualRows = (
  rows: FolioBilingualRow[],
): { units: BilingualUnit[]; dropped: number } => {
  const units: BilingualUnit[] = [];
  let dropped = 0;
  let ordinal = 0;
  const push = (unit: Omit<BilingualUnit, "ordinal">): void => {
    if (unit.sourceText.length > BILINGUAL_LIMITS.rowTextMax) {
      dropped += 1;
      return;
    }
    ordinal += 1;
    units.push({ ...unit, ordinal });
  };
  for (const row of rows) {
    if (row.kind === "table") {
      switch (row.layout) {
        case "inline": {
          for (const paragraph of row.paragraphs) {
            if (!paragraph.paraId || paragraph.sourceText.trim() === "") {
              continue;
            }
            push({
              rowId: paragraph.paraId,
              kind: "table",
              inTable: true,
              tableLayout: row.layout,
              sourceParaId: paragraph.paraId,
              sourceText: paragraph.sourceText,
            });
          }
          break;
        }
        case "stacked": {
          for (const paragraph of row.paragraphs) {
            if (paragraph.sourceText.trim() === "") {
              continue;
            }
            push({
              rowId: paragraph.targetParaId,
              kind: "table",
              inTable: true,
              tableLayout: row.layout,
              sourceParaId: paragraph.sourceParaId ?? null,
              sourceText: paragraph.sourceText,
            });
          }
          break;
        }
        default: {
          row satisfies never;
          return panic(`Unhandled row: ${String(row)}`);
        }
      }
      continue;
    }
    push({
      rowId: row.rowId,
      kind: row.kind,
      inTable: false,
      tableLayout: null,
      sourceParaId: row.sourceParaId ?? null,
      sourceText: row.sourceText,
    });
  }
  return { units, dropped };
};

const LETTER = /\p{L}/u;
const ONLY_PUNCTUATION = /^[\s\p{P}\p{S}\d]*$/u;
const BILINGUAL_SEPARATOR = " / ";
/** Longest line still read as a bilingual heading rather than prose. */
const BILINGUAL_LINE_MAX = 200;

/**
 * "NÁJEMNÍ SMLOUVA / TENANCY AGREEMENT": exactly one spaced slash with letters
 * on both sides. Split rather than matched: the regex for this shape needs
 * repeated unbounded classes around the separator, which backtracks
 * super-linearly on a long line. "a/nebo" and "km/h" have no spaces, so they
 * stay prose.
 */
const isAlreadyBilingual = (text: string): boolean => {
  const halves = text.split(BILINGUAL_SEPARATOR);
  return (
    halves.length === 2 &&
    halves.every((half) => LETTER.test(half) && !half.includes("/"))
  );
};

/**
 * Dispositions no model needs to decide: a row with no letters (amounts,
 * dotted lines, dates), or a line that already carries both languages. Every
 * other row is left undecided for the model.
 */
export const ruleDisposition = (
  unit: BilingualUnit,
): BilingualRowDisposition | null => {
  const text = unit.sourceText.trim();
  if (!LETTER.test(text) || ONLY_PUNCTUATION.test(text)) {
    return BILINGUAL_ROW_DISPOSITION.KEEP;
  }
  if (text.length <= BILINGUAL_LINE_MAX && isAlreadyBilingual(text)) {
    return BILINGUAL_ROW_DISPOSITION.KEEP;
  }
  return null;
};

/** What an undecided row falls back to when the model gave no answer: the
 *  redundant direction, never the one that drops text from translation. */
export const defaultDisposition = (
  unit: BilingualUnit,
): BilingualRowDisposition =>
  unit.inTable
    ? BILINGUAL_ROW_DISPOSITION.INLINE
    : BILINGUAL_ROW_DISPOSITION.TRANSLATE;

// ----------------------------------------------------------------------------
// Glossary candidates
// ----------------------------------------------------------------------------

const QUOTED_TERM_PATTERNS: readonly RegExp[] = [
  // „Smlouva“, „Smluvní strany“ (cs/sk/de low-high quotes)
  /„([^“”"]{2,60})[“”]/gu,
  // "Agreement", “Agreement”
  /[“"]([^”"]{2,60})[”"]/gu,
  // (dále jen Smlouva) / (ďalej len Zmluva) / (hereinafter the Agreement)
  /\((?:dále jen|ďalej len|hereinafter(?: referred to as)?|im Folgenden|ci-après|zwany dalej)\s+(?:the\s+)?[„“"]?([^)„“”"]{2,60})[“”"]?\)/giu,
];

const DEFINED_TERM_SHAPE = /^[\p{Lu}][\p{L}\p{N}\s\-.]*$/u;

/**
 * Terms the document itself defines, found by the quoting conventions legal
 * drafting uses. Deduplicated case-insensitively, capped, document order.
 */
export const detectGlossaryCandidates = (
  texts: readonly string[],
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const pattern of QUOTED_TERM_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const term = match[1]?.trim();
        if (
          !term ||
          !DEFINED_TERM_SHAPE.test(term) ||
          term.length > BILINGUAL_LIMITS.termMax
        ) {
          continue;
        }
        const key = term.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push(term);
        if (out.length >= BILINGUAL_LIMITS.glossaryMax) {
          return out;
        }
      }
    }
  }
  return out;
};

// ----------------------------------------------------------------------------
// Consistency check
// ----------------------------------------------------------------------------

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const STEM_MIN_CHARS = 4;

/**
 * Word-start match that tolerates inflection: the form itself, or its stem
 * (the form minus its final letter, when long enough) followed by any ending.
 * "Smlouv" reaches Smlouvu/Smlouvě/Smlouvou; "Agreemen" reaches Agreements.
 */
const containsForm = (haystack: string, form: string): boolean => {
  const trimmed = form.trim();
  if (trimmed === "") {
    return false;
  }
  const stem = trimmed.length > STEM_MIN_CHARS ? trimmed.slice(0, -1) : trimmed;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(stem)}`, "iu");
  return pattern.test(haystack);
};

// Digit runs, with any separator inside a number splitting it ("1 250,00" ->
// "1", "250", "00"). One alternation-free pattern on purpose: alternating a
// `{2,}` run with a decimal form re-walks the same digits on every retry.
const DIGIT_RUN = /\d+/gu;

/**
 * The numeric tokens a translation must preserve. Single digits are dropped:
 * grammar re-expresses them too often ("7. 2018" -> "July 2018") to be a
 * dependable signal.
 */
const numberTokens = (text: string): Set<string> => {
  const tokens = new Set<string>();
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    if (run.length > 1) {
      tokens.add(run);
    }
  }
  return tokens;
};

export type ConsistencyCheckInput = {
  sourceText: string;
  targetText: string;
  glossary: readonly BilingualGlossaryEntry[];
};

/**
 * Every glossary term present in the source must appear in the target in its
 * agreed rendering (or one of its accepted forms), and every number in the
 * source must survive. Findings are reported, never repaired.
 */
export const checkTranslationConsistency = ({
  sourceText,
  targetText,
  glossary,
}: ConsistencyCheckInput): string[] => {
  const warnings: string[] = [];
  for (const entry of glossary) {
    const sourceForms = [entry.source, ...entry.sourceForms];
    if (!sourceForms.some((form) => containsForm(sourceText, form))) {
      continue;
    }
    const targetForms = [entry.target, ...entry.targetForms];
    if (!targetForms.some((form) => containsForm(targetText, form))) {
      warnings.push(
        `"${entry.source}" should be rendered as "${entry.target}"`,
      );
    }
  }
  const targetNumbers = numberTokens(targetText);
  for (const number of numberTokens(sourceText)) {
    if (!targetNumbers.has(number)) {
      warnings.push(`Number "${number}" is missing from the translation`);
    }
  }
  return warnings;
};
