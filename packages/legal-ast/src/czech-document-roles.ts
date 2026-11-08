import { collapseSpacedLetters, normalizeUnicode } from "@stll/text-normalize";

import type { Block, ParagraphBlock } from "./document-ast.js";

/** Closing formula: `V Brně dne 6. ledna 2016`, `Brno 15. května 2023`. */
export const CZ_CLOSING_RE =
  /^(?:V\s+)?\p{Lu}\p{Ll}+\s+(?:dne\s+)?\d{1,2}\.\s*(?:\p{Ll}+\s+|\d{1,2}\.\s*)?\d{4}/u;

/** Signatory name prefix used in Czech public legal documents. */
export const CZ_JUDGE_NAME_RE =
  /^(?:JUDr\.|Mgr\.|doc\.|prof\.|PhDr\.|Ing\.|Bc\.|RNDr\.|MUDr\.)\s+/u;

/**
 * Court signature marker, matched as whole words on a short line: the office
 * a judge signs under (`předseda senátu`, `předseda rozšířeného senátu`,
 * `člen rozšířeného senátu`, `předseda Ústavního soudu`) or the `v. r.` mark.
 * Declined forms (`samosoudcem`, `předsedy senátu`) belong to running text
 * such as "rozhodl samosoudcem Mgr. …" and never sign a decision. Shared
 * because every Czech court adapter and the statute reader assign the same
 * AST role.
 */
export const CZ_JUDGE_TITLE_RE =
  /^(?=[^]{0,79}$)[^]*?(?<![\p{L}\p{N}])(?:(?:místo)?(?:předseda|předsedkyně)\s+(?:(?:rozšířeného|velkého)\s+)?senátu:?|(?:místo)?(?:předseda|předsedkyně)\s+(?:Ústavního|Nejvyššího(?:\s+správního)?)\s+soudu|(?:člen|členka)\s+(?:rozšířeného|velkého)\s+senátu|samosoudce|samosoudkyně|soud(?:ce|kyně)\s+zpravodaj|v\.\s*r\.\s*$)(?![\p{L}\p{N}])/iu;

const compactUpper = (text: string): string =>
  normalizeUnicode(text, "NFKC")
    .toLocaleUpperCase("cs-CZ")
    .replaceAll(/\s+/gu, "");

/**
 * The lines a Czech decision opens with beside its title: the state and the
 * formula the court decides under. They are the court's words, not its
 * title, so none of them is a `decision-title`. Spacing is not significant
 * (`J M É N E M   R E P U B L I K Y`).
 */
const OPENING_FORMULAE: ReadonlySet<string> = new Set([
  "JMÉNEMREPUBLIKY",
  "JMÉNEMČESKÉREPUBLIKY",
  "ČESKÁREPUBLIKA",
]);

export const isCzechOpeningFormula = (text: string): boolean =>
  OPENING_FORMULAE.has(compactUpper(text));

/** The heading the reasons open under, whatever its spacing. */
const REASONS_HEADINGS: ReadonlySet<string> = new Set([
  "ODŮVODNĚNÍ",
  "ODŮVODNĚNÍ:",
]);

/** Whether a line is the heading of the reasons (`O d ů v o d n ě n í :`). */
export const isCzechReasonsHeading = (text: string): boolean =>
  REASONS_HEADINGS.has(compactUpper(text));

/** The lead-in to the operative part, alone on its line. */
const TAKTO_LINE_RE = /^t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;

/** The lead-in as it ends a sentence naming the bench and the parties. */
export const CZ_TAKTO_TAIL_RE = /(?:^|[\s,])t\s*a\s*k\s*t\s*o\s*(?::\s*)?$/iu;

/** The canonical text of the lead-in, whatever its spacing. */
export const CZ_TAKTO = "takto:";

export const isCzechTaktoLine = (text: string): boolean =>
  TAKTO_LINE_RE.test(text.trim());

// parser-output-unchanged: [cz-nss] only the cz-ns adapter calls normalizeCzechJudgeName.
// parser-output-unchanged: [cz-us] only the cz-ns adapter calls normalizeCzechJudgeName.
// parser-output-unchanged: [cz-regional] only the cz-ns adapter calls normalizeCzechJudgeName.
// Matched after whitespace collapses to single spaces, so each separator is at
// most one space: unbounded `\s*` runs here would backtrack super-linearly.
const JUDGE_SIGNATURE_SUFFIX_RE = / ?,? ?v\. ?r\.$/iu;

/**
 * A judge's name as the signature block prints it: layout whitespace
 * collapsed, a letter-spaced surname (`I š t v á n e k`) joined, and the
 * `v. r.` (vlastní rukou) signature mark removed. Letter spacing is how the
 * signature emphasises the name, not part of it; the mark says how the
 * decision was signed, not who signed it.
 */
export const normalizeCzechJudgeName = (printed: string): string =>
  // Spaced letters are joined before whitespace collapses: one space
  // separates the letters of a spaced word, a wider gap separates words.
  // Any other whitespace (a line break, a tab) is a word gap.
  collapseSpacedLetters(printed.replaceAll(/[^\S ]+/gu, "  "))
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(JUDGE_SIGNATURE_SUFFIX_RE, "")
    .trim();

/**
 * A personal name and nothing else: two to four capitalised words, each
 * possibly double-barrelled ("Jan Novák", "Petra Svobodová-Dvořáková").
 * Judges often sign with no academic title and no "v. r.", so the name signs
 * only where it stands: under the closing, or beside the office it is signed
 * under.
 */
const BARE_SIGNATORY_NAME_RE =
  /^\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?:\s+\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?){1,3}$/u;

/** Whether a line is a bare personal name, as a judge signs without a title. */
export const isCzechBareSignatoryName = (text: string): boolean =>
  BARE_SIGNATORY_NAME_RE.test(text.trim());

/** An office printed beside a signed name in Czech public documents. */
const CZ_PUBLIC_OFFICE_TITLE_RE = /^(?:vice)?guvernér(?:ka)?\s*:?$/iu;
const SIGNATURE_LINE_MAX_CHARS = 80;

/** Whether a line signs a decision under the office a judge holds. */
export const isCzechSignatureLine = (text: string): boolean => {
  const line = text.trim();
  return line.length < SIGNATURE_LINE_MAX_CHARS && CZ_JUDGE_TITLE_RE.test(line);
};

const isSignatureSeed = (block: Block | undefined): boolean =>
  block !== undefined &&
  (block.type === "heading" || block.type === "paragraph") &&
  isCzechSignatureLine(block.plainText);

const isSignatureCompanion = (block: Block | undefined): boolean =>
  block !== undefined &&
  (block.type === "heading" || block.type === "paragraph") &&
  block.plainText.trim().length < SIGNATURE_LINE_MAX_CHARS &&
  (CZ_JUDGE_NAME_RE.test(block.plainText.trim()) ||
    CZ_PUBLIC_OFFICE_TITLE_RE.test(block.plainText.trim()));

const asSignatureParagraph = (block: Block): Block => {
  if (block.type === "paragraph") {
    return { ...block, role: "signature" };
  }
  if (block.type !== "heading") {
    return block;
  }

  return {
    anchorId: block.anchorId,
    id: block.id,
    inlines: block.inlines,
    plainText: block.plainText,
    role: "signature",
    type: "paragraph",
  } satisfies ParagraphBlock;
};

/**
 * Refine recognisable Czech signature lines into the canonical paragraph
 * role. A `v. r.` or court-title line is the seed; an adjacent short name or
 * public-office title joins that signature block. Body prose is untouched.
 */
export const withInferredCzechSignatureRoles = (
  blocks: readonly Block[],
): Block[] => {
  const signatureIndexes = new Set<number>();

  for (const [index, block] of blocks.entries()) {
    if (!isSignatureSeed(block)) {
      continue;
    }
    signatureIndexes.add(index);
    if (isSignatureCompanion(blocks[index - 1])) {
      signatureIndexes.add(index - 1);
    }
    if (isSignatureCompanion(blocks[index + 1])) {
      signatureIndexes.add(index + 1);
    }
  }

  return blocks.map((block, index) =>
    signatureIndexes.has(index) ? asSignatureParagraph(block) : block,
  );
};
