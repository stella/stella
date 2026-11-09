// parser-output-unchanged: [cz-regional] only adds the bench-recital rule, which only the Supreme and Constitutional Court readers call.
// parser-output-unchanged: [cz-uohs] only adds the bench-recital rule, which only the Supreme and Constitutional Court readers call.
// parser-output-unchanged: [cz-nss] only adds the bench-recital rule, which only the Supreme and Constitutional Court readers call.
import { collapseSpacedLetters, normalizeUnicode } from "@stll/text-normalize";

import type { Block, ParagraphBlock } from "./document-ast.js";
import {
  PRINTED_LABEL_KIND,
  readPrintedLabel,
} from "./printed-paragraph-labels.js";

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

/** The heading the instruction on remedies opens under. */
const INSTRUCTION_HEADINGS: ReadonlySet<string> = new Set([
  "POUČENÍ",
  "POUČENÍ:",
]);

/** Whether a line is the heading of the instruction (`P o u č e n í :`). */
export const isCzechInstructionHeading = (text: string): boolean =>
  INSTRUCTION_HEADINGS.has(compactUpper(text));

/**
 * Whether a line is an authority's decision title: the decision word alone
 * or with its issuer (`ROZHODNUTÍ`, `ROZHODNUTÍ PŘEDSEDY ÚŘADU …`), never the
 * lead-in `ROZHODNUTÍ:`.
 */
export const isCzechAuthorityDecisionTitle = (text: string): boolean => {
  const line = text.replaceAll(/\s+/gu, " ").trim();
  return /^ROZHODNUTÍ(?: \p{Lu}[\p{Lu} ]*)?$/u.test(line);
};

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

/** One academic degree printed before a Czech signatory's name. */
const DEGREE_BEFORE_NAME_RE =
  /^(?:JUDr|Mgr|MgA|doc|prof|PhDr|Ing|Bc|BcA|RNDr|MUDr|ThDr|PaedDr|Dr)\. ?/u;
/** One degree printed after the name, with its comma. */
const DEGREE_AFTER_NAME_RE =
  /,? ?(?:Ph\. ?D\.|Th\. ?D\.|LL\. ?M\.|M\. ?A\.|CSc\.|DrSc\.|MSc\.|MBA)$/u;
/** Longest line a signed name with its degrees takes. */
const SIGNATURE_NAME_MAX_CHARS = 80;
/** More degrees than any signatory carries on one side of a name. */
const MAX_DEGREES_PER_SIDE = 4;

const withoutDegrees = (name: string): string => {
  let bare = name;
  for (let step = 0; step < MAX_DEGREES_PER_SIDE; step += 1) {
    bare = bare
      .replace(DEGREE_BEFORE_NAME_RE, "")
      .replace(DEGREE_AFTER_NAME_RE, "")
      .trim();
  }
  return bare;
};

/**
 * A signatory's name as a Czech court prints it under the closing: a
 * personal name, with or without its academic degrees (`JUDr. Miluše
 * Došková`, `Mgr. Miroslav Hromada, Ph.D.`), the `v. r.` signature mark, or
 * a letter-spaced surname (`JUDr. František B a l á k, v.r.`).
 */
export const isCzechSignatoryName = (text: string): boolean =>
  text.trim().length < SIGNATURE_NAME_MAX_CHARS &&
  isCzechBareSignatoryName(withoutDegrees(normalizeCzechJudgeName(text)));

/**
 * The court office's certification that a copy matches the decision
 * (`Za správnost vyhotovení:`), printed under the judges' signatures with
 * the name of the clerk who made the copy. It is not a judge's signature.
 */
const COPY_CERTIFICATION_RE = /^Za správnost vyhotovení(?!\p{L})/iu;

/** Whether a line opens the certification of a decision's copy. */
export const isCzechCopyCertification = (text: string): boolean =>
  COPY_CERTIFICATION_RE.test(
    // Spaced letters are joined while the wider word gap still shows.
    collapseSpacedLetters(
      normalizeUnicode(text, "NFC").replaceAll("\u00a0", " ").trim(),
    ).replaceAll(/\s+/gu, " "),
  );

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

/**
 * The lead-in an authority's operative part opens after: the sentence that
 * ends `rozhodl takto:`, a bare `rozhodl:`, or the decision word on its own
 * line (`ROZHODNUTÍ:`) after `vydává … toto`.
 */
const RULED_TAIL_RE = /(?:^|[\s,])rozhodl[ao]?\s?:$/iu;
const DECISION_WORD_LEAD_IN = "ROZHODNUTÍ:";

/** Whether a line is the lead-in the operative part follows. */
export const isCzechRulingLeadIn = (text: string): boolean => {
  const line = collapseSpacedLetters(text).replaceAll(/\s+/gu, " ").trim();
  return (
    isCzechTaktoLine(line) ||
    CZ_TAKTO_TAIL_RE.test(line) ||
    RULED_TAIL_RE.test(line) ||
    compactUpper(line) === DECISION_WORD_LEAD_IN
  );
};

/**
 * The office an authority's head signs under (`předseda Úřadu …`,
 * `I. místopředseda Úřadu`, `… místopředsedkyně`), on a short line.
 */
const CZ_AUTHORITY_OFFICE_RE =
  /(?:^|\s)(?:místo)?(?:předseda|předsedkyně)(?:\sÚřadu(?:\spro\sochranu\shospodářské\ssoutěže)?)?$/u;

/** Longest line an authority's signature runs to: titles, name and office. */
const AUTHORITY_SIGNATURE_MAX_CHARS = 120;

/** Whether a short line signs an authority's decision under its office. */
export const isCzechAuthoritySignatureLine = (text: string): boolean => {
  const line = text.replaceAll(/\s+/gu, " ").trim();
  return (
    line.length < AUTHORITY_SIGNATURE_MAX_CHARS &&
    CZ_AUTHORITY_OFFICE_RE.test(line)
  );
};

/**
 * The roles of an authority's decision up to its reasons, read from the
 * decision's own parts: the head matter (letterhead, title, the sentence
 * naming the proceedings) up to and with the lead-in is `intro`, the
 * operative part after it is `holding`, and from the reasons heading on
 * nothing is read. Nothing is returned when the decision prints no lead-in
 * or no reasons heading, so a caller keeps its own reading.
 */
export const czechAuthorityHeadRoles = (
  texts: readonly string[],
): ("intro" | "holding" | undefined)[] | undefined => {
  const reasons = texts.findIndex(isCzechReasonsHeading);
  if (reasons === -1) {
    return undefined;
  }
  const leadIn = texts.slice(0, reasons).findIndex(isCzechRulingLeadIn);
  if (leadIn === -1) {
    return undefined;
  }
  return texts.map((_, index) => {
    if (index <= leadIn) {
      return "intro";
    }
    return index < reasons ? "holding" : undefined;
  });
};

/**
 * The lines a criminal verdict prints between the parts of its ruling, each
 * on its own line: `je vinen, že`, `tedy`, `čímž spáchal`, `tím spáchal`,
 * `přičemž`, `a odsuzuje se`. The verdict's sentence runs on across them by
 * the court's own layout, not where a line or a page ended.
 */
const VERDICT_FORMULA_RE =
  /^(?:(?:je|jsou) vinn?\p{Ll}*,? že|tedy|čímž? spáchal\p{Ll}*|tím spáchal\p{Ll}*|přičemž|a odsuzuj\p{Ll}+ se)(?!\p{L})/iu;

/** Whether a line opens one of a criminal verdict's formula lines. */
export const isCzechVerdictFormulaLine = (text: string): boolean =>
  VERDICT_FORMULA_RE.test(
    collapseSpacedLetters(text.trim()).replaceAll(/\s+/gu, " "),
  );

/** Most paragraphs a bench recital is printed in. */
const BENCH_RECITAL_MAX_PARAGRAPHS = 3;
/** The labels a court numbers its paragraphs with: `12.`, `[12]`, `5.5.`. */
const COURT_NUMBER_KINDS: ReadonlySet<string> = new Set([
  PRINTED_LABEL_KIND.BRACKET,
  PRINTED_LABEL_KIND.NUMBER,
  PRINTED_LABEL_KIND.SUBNUMBER,
]);

/** Whether a paragraph opens on the court's number: it is reasoning. */
const opensOnCourtNumber = (text: string): boolean => {
  const label = readPrintedLabel(text);
  return label !== null && COURT_NUMBER_KINDS.has(label.kind);
};
/** The verb a bench recital states its decision with (`… rozhodl …`). */
const BENCH_DECIDED_RE = /(?<!\p{L})rozhodl[aoi]?(?!\p{L})/iu;

/**
 * Where the bench recital ending before `end` starts (`Ústavní soud České
 * republiky` / `v senátě rozhodl ve věci … `, or one paragraph ending
 * `takto:`): the role-less paragraphs that run back to the decision's head
 * matter (its title, docket or opening formula). Only a short recital that
 * carries no court number and states the bench's decision (`rozhodl`) is
 * one, so a `takto:` the reasons quote, or a docket line above it, is not;
 * `undefined` when the paragraphs before `end` are no recital. A reader
 * whose blocks open after the head matter it keeps apart says so with
 * `opensAfterHeadMatter`: a recital may then run back to its first block.
 */
export const czechBenchRecitalStart = (
  blocks: readonly Block[],
  end: number,
  { opensAfterHeadMatter = false }: { opensAfterHeadMatter?: boolean } = {},
): number | undefined => {
  let start = end;
  while (start > 0) {
    const previous = blocks.at(start - 1);
    if (previous?.type !== "paragraph" || previous.role !== undefined) {
      break;
    }
    start -= 1;
  }
  // `at(-1)` would read the last block: at the start there is no head.
  const head = start > 0 ? blocks.at(start - 1) : undefined;
  const followsHeadMatter =
    head === undefined
      ? opensAfterHeadMatter
      : (head.type === "heading" && head.role === "decision-title") ||
        (head.type === "paragraph" &&
          (head.role === "case-number" ||
            head.role === "intro" ||
            head.role === "apparatus"));
  const recital = blocks.slice(start, end);
  return followsHeadMatter &&
    recital.length > 0 &&
    recital.length <= BENCH_RECITAL_MAX_PARAGRAPHS &&
    !recital.some((block) => opensOnCourtNumber(block.plainText)) &&
    recital.some((block) => BENCH_DECIDED_RE.test(block.plainText))
    ? start
    : undefined;
};
