/**
 * Printed-page structure that survived into a decision's blocks.
 *
 * A decision that reaches its publisher as a printed page carries the
 * page's own layout: page numbers between paragraphs, sentences cut where a
 * line or a page ended, a number pushed to the start of the next line. A
 * parser that reads those lines without the shared owners (the line reflow
 * in `hard-wrapped-lines.ts`, the page furniture in `page-furniture.ts`)
 * stores the layout as structure, and every reader of the blocks (the
 * reader's paragraphs, search, citation extraction, the AI pipeline) takes
 * it for the court's.
 *
 * The specific defect is always a parser's and is fixed there, through the
 * owners. This is the class-level guard, like `markup-residue.ts`: one scan
 * over the blocks every source produces, whatever its jurisdiction or
 * format. It runs inside `validateAst` for parsed decisions, and the
 * structure-fidelity guard test runs it over every adapter's recorded
 * fixtures against a shrink-only baseline.
 *
 * The rules are language-agnostic and read only what the blocks state:
 * their order, type, role and text. A rule that needs a jurisdiction's
 * vocabulary belongs to that vocabulary's owner.
 */

// parser-output-unchanged: imports the document AST from its package owner
import type { Block } from "@stll/legal-ast/document-ast";

import {
  continuesAcrossPageBreak,
  isPageNumberLine,
} from "@/api/lib/legal-search/parsers/page-furniture";

export const STRUCTURE_FIDELITY_RULES = {
  /** A paragraph that is only a page number: the page's, not the court's. */
  PAGE_NUMBER_BLOCK: "page-number-block",
  /** A sentence that goes on in the next paragraph of the same role. */
  SENTENCE_CUT: "sentence-cut",
  /**
   * A paragraph opening on a bare number and a word: a page number or a
   * superscript the line above lost (`art. 479` / `45 wzorców`), or a
   * date cut off its sentence (`dnia` / `22 marca 2018 r.`).
   */
  STRAY_LEADING_NUMBER: "stray-leading-number",
  /**
   * Holding after the signatures: the operative part ends before the
   * judges sign, so a role carried past them was never closed.
   */
  HOLDING_AFTER_SIGNATURE: "holding-after-signature",
} as const;

type StructureFidelityRule =
  (typeof STRUCTURE_FIDELITY_RULES)[keyof typeof STRUCTURE_FIDELITY_RULES];

export type StructureFidelityFinding = {
  rule: StructureFidelityRule;
  anchorId: string;
  excerpt: string;
};

const EXCERPT_CHARS = 120;

/**
 * A number, then a lower-case word: not a list item (`2.`, `2)`), not a
 * year or an amount (four digits and more), not a docket or a reporter
 * citation (`23 Cdo 3470/2015`, `322 U.S. 385`), whose next word is
 * capitalised.
 */
const STRAY_LEADING_NUMBER_RE = /^\d{1,3}\s+\p{Ll}/u;

/**
 * A paragraph opening on a short label (`žalobce:`, `orzeka:`, `písm. b):`):
 * head matter and enumerations set apart by the court, whose clauses run on
 * from the paragraph before by design.
 */
const OPENS_ON_LABEL_RE = /^[^:\n]{1,25}:/u;

/** Units a table row prints beside its figures, compared lowercased. */
const TABLE_UNITS: ReadonlySet<string> = new Set([
  "%",
  "‰",
  "°",
  "°c",
  "m",
  "cm",
  "mm",
  "km",
  "m2",
  "m3",
  "m/s",
  "km/h",
  "kg",
  "g",
  "mg",
  "t",
  "l",
  "ml",
  "s",
  "min",
  "h",
  "kw",
  "mw",
  "kwh",
  "mwh",
  "db",
  "pa",
  "hz",
]);
/** Tokens carrying a digit a row needs before it can be a table row. */
const TABLE_MIN_FIGURES = 3;
/**
 * Share of a row's tokens that must be figures or units, strictly above:
 * a citation of a provision (`§ 75 Abs. 1 und 75 Abs. 2 der GewO 1994`)
 * stays at half and is prose.
 */
const TABLE_FIGURE_SHARE = 0.5;
const TRAILING_PUNCTUATION_RE = /[,;.)]+$/u;

/**
 * A printed table row, not prose: it carries no sentence a page could cut,
 * so neither it nor its neighbour is judged for one.
 */
const isTableRow = (text: string): boolean => {
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0);
  const figures = tokens.filter((token) => /\d/u.test(token)).length;
  const units = tokens.filter((token) =>
    TABLE_UNITS.has(token.toLowerCase().replace(TRAILING_PUNCTUATION_RE, "")),
  ).length;
  return (
    figures >= TABLE_MIN_FIGURES &&
    (figures + units) / tokens.length > TABLE_FIGURE_SHARE
  );
};

const excerptOf = (text: string): string => text.slice(0, EXCERPT_CHARS);

/** Every printed-page structure the blocks carry, in document order. */
export const structureFidelityIn = (
  blocks: readonly Block[],
): StructureFidelityFinding[] => {
  const findings: StructureFidelityFinding[] = [];
  let signed = false;
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "paragraph") {
      continue;
    }
    const text = block.plainText.trim();
    const finding = (rule: StructureFidelityRule, excerpt = text) =>
      findings.push({
        rule,
        anchorId: block.anchorId,
        excerpt: excerptOf(excerpt),
      });
    if (block.role === "signature") {
      signed = true;
    }
    if (block.role === "holding" && signed) {
      finding(STRUCTURE_FIDELITY_RULES.HOLDING_AFTER_SIGNATURE);
    }
    if (isPageNumberLine(text)) {
      finding(STRUCTURE_FIDELITY_RULES.PAGE_NUMBER_BLOCK);
    } else if (STRAY_LEADING_NUMBER_RE.test(text)) {
      finding(STRUCTURE_FIDELITY_RULES.STRAY_LEADING_NUMBER);
    }
    const next = blocks[index + 1];
    const nextText = next?.plainText.trim() ?? "";
    if (
      next?.type === "paragraph" &&
      next.role === block.role &&
      !OPENS_ON_LABEL_RE.test(nextText) &&
      !isTableRow(text) &&
      !isTableRow(nextText) &&
      continuesAcrossPageBreak(text, nextText)
    ) {
      finding(
        STRUCTURE_FIDELITY_RULES.SENTENCE_CUT,
        `${text.slice(-EXCERPT_CHARS / 2)} ⏎ ${nextText}`,
      );
    }
  }
  return findings;
};
