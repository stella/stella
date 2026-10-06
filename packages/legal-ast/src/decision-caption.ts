/**
 * A decision's caption, recognised for display.
 *
 * Czech and Slovak courts open a decision with a printed caption: the court
 * (often over two lines), the case number, the state, the kind of decision
 * and the constitutional formula. Some sources store it as one paragraph,
 * which a reader then draws as one run-on line:
 * `NEJVYŠŠÍ SOUD ČESKÉ REPUBLIKY 21 Cdo 1484/2004 ČESKÁ REPUBLIKA ROZSUDEK
 * JMÉNEM REPUBLIKY`. The stored text stays exactly as published; this module
 * only names the lines a reader may draw it as.
 *
 * Nothing here rewrites text. A line is a range of its block's plain text
 * (`plainTextOf`, the axis search ranges and annotation offsets index), so a
 * reader that draws each line from its range keeps every block anchor and
 * offset as stored.
 *
 * The vocabulary is data, one {@link CaptionForms} per jurisdiction; the
 * recogniser is the same for all of them.
 */

import { escapeRegExp } from "@stll/text-normalize";

import type { Block, HeadingBlock, ParagraphBlock } from "./document-ast.js";
import { plainTextOf } from "./document-ast.js";

export const CAPTION_LINE_KIND = {
  /** The court's name, or the second line it continues on. */
  COURT: "court",
  CASE_NUMBER: "case-number",
  /** The state the court decides for: `ČESKÁ REPUBLIKA`. */
  STATE: "state",
  /** What the decision is: `ROZSUDEK`, `U S N E S E N Í`. */
  DECISION_TYPE: "decision-type",
  /** The formula the court decides under: `JMÉNEM REPUBLIKY`. */
  FORMULA: "formula",
} as const;

export type CaptionLineKind =
  (typeof CAPTION_LINE_KIND)[keyof typeof CAPTION_LINE_KIND];

/** One printed caption line: `[start, end)` of its block's plain text. */
type CaptionLine = { kind: CaptionLineKind; start: number; end: number };

type CaptionBlock = {
  block: HeadingBlock | ParagraphBlock;
  lines: [CaptionLine, ...CaptionLine[]];
};

/** The leading blocks that hold the caption, in document order. */
export type DecisionCaption = {
  blocks: [CaptionBlock, ...CaptionBlock[]];
};

/**
 * A jurisdiction's caption vocabulary: per line kind, a pattern matching one
 * printed line (sticky, so it is tried at one position).
 */
export type CaptionForms = Record<CaptionLineKind, RegExp>;

/** Whitespace within one printed line. */
const GAP = String.raw`[^\S\n]+`;

/** A phrase as courts print it in a caption: in capitals or as written. */
const phrase = (words: string): string => {
  const written = words.split(" ").map(escapeRegExp).join(GAP);
  const capitals = words
    .toLocaleUpperCase("cs")
    .split(" ")
    .map(escapeRegExp)
    .join(GAP);
  return written === capitals ? written : `(?:${capitals}|${written})`;
};

const graphemes = new Intl.Segmenter("cs", { granularity: "grapheme" });

/** A one-word title in capitals, also letter-spaced: `U S N E S E N Í`. */
const title = (word: string): string => {
  const letters = Array.from(
    graphemes.segment(word.toLocaleUpperCase("cs")),
    ({ segment }) => escapeRegExp(segment),
  );
  return `(?:${letters.join("")}|${letters.join(" ")}|${escapeRegExp(word)})`;
};

const alternatives = (sources: readonly string[]): string =>
  `(?:${sources.join("|")})`;

/** A whole line part: the pattern, then whitespace or the end of the text. */
const linePattern = (source: string): RegExp =>
  new RegExp(`${source}(?=\\s|$)`, "uy");

/** A place a lower court sits in: `v Brně`, `pro Prahu 1`, `v Ústí nad Labem`. */
const seat = (prepositions: readonly string[]): string => {
  const place = String.raw`[\p{Lu}\d][\p{L}\d]*`;
  const joiner = String.raw`(?:nad|pod|NAD|POD)`;
  return (
    `(?:${GAP}${alternatives(prepositions)}${GAP}${place}` +
    `(?:${GAP}(?:${joiner}${GAP})?${place})?)?`
  );
};

/** A court, optionally with its seat and the state it is the court of. */
const court = ({
  courts,
  ofState,
  prepositions,
}: {
  courts: readonly string[];
  ofState: string;
  prepositions: readonly string[];
}): string =>
  alternatives([
    `${alternatives(courts.map(phrase))}${seat(prepositions)}(?:${GAP}${phrase(ofState)})?`,
    phrase(ofState),
  ]);

/**
 * A docket as Czech and Slovak captions print it: `21 Cdo 1484/2004`,
 * `29 ICdo 37/2013`, `I. ÚS 245/98`, `Pl. ÚS 1/03`, `6 As 12/2010 - 45`,
 * `4Obo/45/2011`.
 */
const CASE_NUMBER_SOURCE = alternatives([
  String.raw`(?:\d{1,3}|[IVX]{1,4}\.|Pl\.|PL\.)[^\S\n]?\p{L}{1,6}\.?[^\S\n]?\d{1,6}\/\d{2,4}(?:[^\S\n]?-[^\S\n]?\d{1,4})?`,
  String.raw`\d{1,2}[^\S\n]?\p{L}{1,6}\/\d{1,6}\/\d{4}`,
]);

export const CZ_CAPTION_FORMS = {
  court: linePattern(
    court({
      courts: [
        "Nejvyšší správní soud",
        "Nejvyšší soud",
        "Ústavní soud",
        "Vrchní soud",
        "Krajský soud",
        "Městský soud",
        "Obvodní soud",
        "Okresní soud",
      ],
      ofState: "České republiky",
      prepositions: ["v", "ve", "pro", "V", "VE", "PRO"],
    }),
  ),
  "case-number": linePattern(CASE_NUMBER_SOURCE),
  state: linePattern(phrase("Česká republika")),
  "decision-type": linePattern(
    alternatives([
      phrase("Platební rozkaz"),
      phrase("Trestní příkaz"),
      ...["Rozsudek", "Usnesení", "Nález", "Stanovisko", "Opatření"].map(title),
    ]),
  ),
  formula: linePattern(
    alternatives([
      phrase("Jménem České republiky"),
      phrase("Jménem republiky"),
    ]),
  ),
} as const satisfies CaptionForms;

export const SK_CAPTION_FORMS = {
  court: linePattern(
    court({
      courts: [
        "Najvyšší správny súd",
        "Najvyšší súd",
        "Ústavný súd",
        "Špecializovaný trestný súd",
        "Krajský súd",
        "Okresný súd",
      ],
      ofState: "Slovenskej republiky",
      prepositions: ["v", "vo", "V", "VO"],
    }),
  ),
  "case-number": linePattern(CASE_NUMBER_SOURCE),
  state: linePattern(phrase("Slovenská republika")),
  "decision-type": linePattern(
    alternatives([
      phrase("Trestný rozkaz"),
      ...[
        "Rozsudok",
        "Uznesenie",
        "Nález",
        "Príkaz",
        "Rozhodnutie",
        "Stanovisko",
      ].map(title),
    ]),
  ),
  formula: linePattern(phrase("V mene Slovenskej republiky")),
} as const satisfies CaptionForms;

/** Caption lines are tried in this order; the longest match wins. */
const LINE_KINDS = Object.values(CAPTION_LINE_KIND);

/** The lines that say whose decision it is, one of which a caption names. */
const NAMING_KINDS = [
  CAPTION_LINE_KIND.COURT,
  CAPTION_LINE_KIND.STATE,
  CAPTION_LINE_KIND.FORMULA,
] as const;

/** How far into a document a caption may reach. */
const MAX_CAPTION_BLOCKS = 12;

const LEADING_SPACE_RE = /\s*/uy;

/** The longest caption line at `at`, or null when none starts there. */
const lineAt = (
  text: string,
  at: number,
  forms: CaptionForms,
): CaptionLine | null => {
  let best: CaptionLine | null = null;
  for (const kind of LINE_KINDS) {
    const pattern = forms[kind];
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (match === null) {
      continue;
    }
    const end = at + match[0].length;
    if (best === null || end > best.end) {
      best = { kind, start: at, end };
    }
  }
  return best;
};

/** The block's text read as caption lines, or null when any of it is not. */
const captionLines = (
  text: string,
  forms: CaptionForms,
): CaptionBlock["lines"] | null => {
  const lines: CaptionLine[] = [];
  let at = 0;
  for (;;) {
    LEADING_SPACE_RE.lastIndex = at;
    at += LEADING_SPACE_RE.exec(text)?.[0].length ?? 0;
    if (at >= text.length) {
      break;
    }
    const line = lineAt(text, at, forms);
    if (line === null) {
      return null;
    }
    lines.push(line);
    at = line.end;
  }
  const [first, ...rest] = lines;
  return first === undefined ? null : [first, ...rest];
};

/**
 * Plain text only: a caption line is drawn from its range, so a block whose
 * inlines carry links, formatting or an anonymized span keeps the renderer
 * that draws them.
 */
const isPlainBlock = (block: Block): block is HeadingBlock | ParagraphBlock =>
  (block.type === "heading" ||
    (block.type === "paragraph" &&
      block.number === undefined &&
      block.note === undefined &&
      block.listDepth === undefined)) &&
  block.inlines.every(
    (inline) =>
      inline.type === "line-break" ||
      (inline.type === "text" && inline.anonymized === undefined),
  );

/**
 * The caption a decision opens with, when its leading blocks are one that a
 * reader would otherwise draw wrongly: a block holding several caption lines
 * run together, or a caption line stored as a plain paragraph.
 *
 * Every character of a caption block must read as a caption line, so a
 * sentence that merely opens with a court's name ("Nejvyšší soud rozhodl
 * …") is never one. The caption must name the kind of decision and the
 * court, the state or the formula; a decision type beside a docket is no
 * caption.
 */
export const detectDecisionCaption = (
  blocks: readonly Block[],
  forms: CaptionForms,
): DecisionCaption | null => {
  const captionBlocks: CaptionBlock[] = [];
  for (const block of blocks.slice(0, MAX_CAPTION_BLOCKS)) {
    if (!isPlainBlock(block)) {
      break;
    }
    const lines = captionLines(plainTextOf(block.inlines), forms);
    if (lines === null) {
      break;
    }
    captionBlocks.push({ block, lines });
  }
  const kinds = new Set(
    captionBlocks.flatMap(({ lines }) => lines.map(({ kind }) => kind)),
  );
  const drawnWrongly = captionBlocks.some(
    ({ block, lines }) => lines.length > 1 || block.type === "paragraph",
  );
  const [first, ...rest] = captionBlocks;
  if (
    first === undefined ||
    !drawnWrongly ||
    !kinds.has(CAPTION_LINE_KIND.DECISION_TYPE) ||
    !NAMING_KINDS.some((kind) => kinds.has(kind))
  ) {
    return null;
  }
  return { blocks: [first, ...rest] };
};
