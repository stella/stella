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
 * The printed-page rules are language-agnostic and read only what the
 * blocks state: their order, type, role and text. The role rules read a line
 * through its language's role grammar (`@stll/legal-ast/decision-role-grammar`),
 * the same owner every parser of that language calls, so a check and a
 * parser can never read a signature or a reasons heading differently.
 */

import {
  type DecisionRoleGrammar,
  decisionRoleGrammarOf,
} from "@stll/legal-ast/decision-role-grammar";
// parser-output-unchanged: imports the document AST from its package owner
import type { Block } from "@stll/legal-ast/document-ast";
import {
  PRINTED_LABEL_KIND,
  readPrintedLabel,
} from "@stll/legal-ast/printed-paragraph-labels";

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
  /**
   * A line the decision is signed with, read as its ruling: the parser
   * carried the operative part past the end of it.
   */
  SIGNATURE_AS_HOLDING: "signature-as-holding",
  /**
   * Holding after the reasons heading: the ruling precedes the reasons, so
   * a parser that did not see the heading read the reasons as the ruling.
   */
  HOLDING_AFTER_REASONS: "holding-after-reasons",
  /**
   * The recital or the legal basis before the ruling, read as the ruling:
   * the parser opened the operative part before its first operative line.
   */
  RECITAL_AS_HOLDING: "recital-as-holding",
  /**
   * A decision that opens a ruling before its reasons and holds no holding
   * block: the parser read the ruling as head matter or as reasons.
   */
  RULING_WITHOUT_HOLDING: "ruling-without-holding",
  /**
   * The instruction on the remedy against the decision, read as its ruling:
   * the parser carried the operative part on past the ruling's end.
   */
  INSTRUCTION_AS_HOLDING: "instruction-as-holding",
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

/**
 * One word and no punctuation, between two labelled lines: the separator a
 * court sets on its own line between parties (`žalobce: …` / `proti` /
 * `žalovaná: …`), not the rest of a cut sentence.
 */
const SEPARATOR_WORD_RE = /^\p{L}+$/u;

const separatesLabelledLines = (
  nextText: string,
  afterNext: Block | undefined,
): boolean =>
  SEPARATOR_WORD_RE.test(nextText) &&
  afterNext?.type === "paragraph" &&
  OPENS_ON_LABEL_RE.test(afterNext.plainText.trim());

/** The labels a list's points open on: `2.`, `2)`, `b)`, `5.5.`. */
const LIST_POINT_KINDS: ReadonlySet<string> = new Set([
  PRINTED_LABEL_KIND.NUMBER,
  PRINTED_LABEL_KIND.SUBNUMBER,
  PRINTED_LABEL_KIND.LETTER,
]);

/** A list point a sentence names before its label (`v bode 2) …`). */
const NAMED_POINT_PREFIX = "v bode ";

/**
 * Whether a paragraph is a point of a list the sentence runs on into,
 * opening on its label as the printed-label grammar reads it (`b) …`,
 * `v bode 2) …`): the list's own paragraph, not the rest of a cut sentence.
 */
const opensListPoint = (text: string): boolean => {
  const point = text.startsWith(NAMED_POINT_PREFIX)
    ? text.slice(NAMED_POINT_PREFIX.length)
    : text;
  const label = readPrintedLabel(point);
  return label !== null && LIST_POINT_KINDS.has(label.kind);
};

/**
 * Whether a paragraph break inside a criminal verdict's ruling falls at one
 * of the verdict's formula lines (`uznáva sa za vinného, že`, `teda`), which
 * the court prints on lines of their own.
 */
const breaksAtVerdictFormula = (
  grammar: DecisionRoleGrammar | undefined,
  role: string | undefined,
  text: string,
  nextText: string,
): boolean =>
  role === "holding" &&
  grammar?.isVerdictFormulaLine !== undefined &&
  (grammar.isVerdictFormulaLine(text) ||
    grammar.isVerdictFormulaLine(nextText));

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
const TRAILING_PUNCTUATION_RE = /[,;.)]$/u;

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

type RoleReading = {
  grammar: DecisionRoleGrammar | undefined;
  reasoned: boolean;
  /** Whether a line that rules has been read: the head matter is over. */
  ruled: boolean;
  /** The first block before the reasons that opens a ruling. */
  rulingOpening: Block | undefined;
  /** Whether any paragraph is the decision's holding. */
  held: boolean;
};

/** Whether a block opens the reasons, by the language's grammar. */
const opensReasons = (
  grammar: DecisionRoleGrammar | undefined,
  block: Block,
): boolean =>
  grammar !== undefined &&
  (block.type === "heading" || block.type === "paragraph") &&
  grammar.isReasonsHeading(block.plainText);

/** The role rules a holding paragraph breaks, by the language's grammar. */
const holdingRoleRules = (
  { grammar, reasoned, ruled }: RoleReading,
  text: string,
): StructureFidelityRule[] => [
  ...(reasoned ? [STRUCTURE_FIDELITY_RULES.HOLDING_AFTER_REASONS] : []),
  ...(grammar?.isSignatureLine?.(text) === true
    ? [STRUCTURE_FIDELITY_RULES.SIGNATURE_AS_HOLDING]
    : []),
  ...(!ruled && grammar?.isRecitalLine?.(text) === true
    ? [STRUCTURE_FIDELITY_RULES.RECITAL_AS_HOLDING]
    : []),
  ...(grammar?.isAppealInstruction?.(text) === true
    ? [STRUCTURE_FIDELITY_RULES.INSTRUCTION_AS_HOLDING]
    : []),
];

/** Whether a block opens a ruling, by the language's grammar. */
const opensRuling = (
  grammar: DecisionRoleGrammar | undefined,
  block: Block,
): boolean =>
  (block.type === "heading" || block.type === "paragraph") &&
  grammar?.opensRuling?.(block.plainText) === true;

/** Whether a block rules, by the language's grammar. */
const rules = (
  grammar: DecisionRoleGrammar | undefined,
  block: Block,
): boolean =>
  (block.type === "heading" || block.type === "paragraph") &&
  grammar?.isOperativeLine?.(block.plainText) === true;

/**
 * Every printed-page structure the blocks carry, in document order, and
 * every role the decision's language grammar reads otherwise.
 */
export const structureFidelityIn = (
  blocks: readonly Block[],
  language?: string,
): StructureFidelityFinding[] => {
  const findings: StructureFidelityFinding[] = [];
  let signed = false;
  const reading: RoleReading = {
    grammar: decisionRoleGrammarOf(language),
    reasoned: false,
    ruled: false,
    rulingOpening: undefined,
    held: false,
  };
  for (const [index, block] of blocks.entries()) {
    const opens = opensReasons(reading.grammar, block);
    reading.ruled ||= rules(reading.grammar, block);
    if (
      reading.rulingOpening === undefined &&
      !reading.reasoned &&
      opensRuling(reading.grammar, block)
    ) {
      reading.rulingOpening = block;
    }
    if (block.type !== "paragraph") {
      reading.reasoned ||= opens;
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
    if (block.role === "holding") {
      reading.held = true;
      for (const rule of holdingRoleRules(reading, text)) {
        finding(rule);
      }
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
      !separatesLabelledLines(nextText, blocks[index + 2]) &&
      !opensListPoint(nextText) &&
      !breaksAtVerdictFormula(reading.grammar, block.role, text, nextText) &&
      continuesAcrossPageBreak(text, nextText)
    ) {
      finding(
        STRUCTURE_FIDELITY_RULES.SENTENCE_CUT,
        `${text.slice(-EXCERPT_CHARS / 2)} ⏎ ${nextText}`,
      );
    }
    reading.reasoned ||= opens;
  }
  const opening = reading.rulingOpening;
  if (opening !== undefined && !reading.held) {
    findings.push({
      rule: STRUCTURE_FIDELITY_RULES.RULING_WITHOUT_HOLDING,
      anchorId: opening.anchorId,
      excerpt: excerptOf(opening.plainText.trim()),
    });
  }
  return findings;
};
