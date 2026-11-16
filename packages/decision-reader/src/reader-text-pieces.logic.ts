/**
 * The text a decision reader draws and anchors marks in: the publisher's
 * headnote and abstract, then the decision's body. One projection for every
 * reader of it, the reader that draws a mark and the server that places one
 * for an agent, so neither can find words the other does not show. Kept free
 * of rendering code, so a server can import it without the DOM.
 */
import { panic } from "better-result";

import {
  DECISION_TEXT_FIELD,
  type ReadDecisionTextFields,
  TEXT_FIELD_TYPE,
  type TextField,
} from "@stll/api-contract/case-law-text-field";
import {
  readerAnchorPiecesOf,
  visibleDecisionBlocks,
} from "@stll/legal-ast/case-law-reader";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import {
  isHeadMatterBlock,
  parseDocumentAst,
  PUBLISHER_SUMMARY_ROLES,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  ParagraphBlock,
  PublisherSummaryRole,
} from "@stll/legal-ast/document-ast";
import type { ReaderTextPiece } from "@stll/legal-ast/reader-text-quote";

/** What the projection reads of a decision, as the read route serves it. */
export type ReaderTextDecision = {
  caseNumberType: DecisionPrimaryReferenceType;
  documentAst: unknown;
  fulltext: string | null;
  textFields: ReadDecisionTextFields;
};

export type EditorialSupplementBlock = {
  end: number;
  start: number;
  text: string;
  type: "heading" | "paragraph";
};

const EDITORIAL_BLOCK_BOUNDARY_RE =
  /(?<=[.!?])(?=\p{Lu})|(?<=[\p{Ll}])(?=\p{Lu})/gu;
const EXPLICIT_EDITORIAL_BLOCK_BREAK_RE = /\n[\t ]*\n+/gu;
const EDITORIAL_HEADING_MAX_CHARS = 120;
const TERMINAL_PUNCTUATION_RE = /[.!?][”’"']?$/u;

const editorialBlock = (
  source: string,
  rawStart: number,
  rawEnd: number,
): EditorialSupplementBlock | null => {
  const raw = source.slice(rawStart, rawEnd);
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  const leadingWhitespace = raw.length - raw.trimStart().length;
  const start = rawStart + leadingWhitespace;
  const end = start + text.length;
  const type =
    text.length <= EDITORIAL_HEADING_MAX_CHARS &&
    !TERMINAL_PUNCTUATION_RE.test(text)
      ? "heading"
      : "paragraph";
  return { end, start, text, type };
};

/**
 * Render publisher-preserved blank lines as authoritative block boundaries.
 * The adjacency inference only supports rows projected before the CZ-US raw
 * replay path existed; remove it after those rows have been reprocessed.
 * Offsets remain on the untouched source string so reader search highlights
 * still land on the correct characters.
 */
export const editorialSupplementBlocks = (
  source: string,
): EditorialSupplementBlock[] => {
  const explicitBreaks = [
    ...source.matchAll(EXPLICIT_EDITORIAL_BLOCK_BREAK_RE),
  ];
  if (explicitBreaks.length > 0) {
    const explicitBlocks: EditorialSupplementBlock[] = [];
    let explicitStart = 0;
    for (const match of explicitBreaks) {
      const block = editorialBlock(source, explicitStart, match.index);
      if (block !== null) {
        explicitBlocks.push(block);
      }
      explicitStart = match.index + match[0].length;
    }
    const finalBlock = editorialBlock(source, explicitStart, source.length);
    if (finalBlock !== null) {
      explicitBlocks.push(finalBlock);
    }
    return explicitBlocks;
  }

  const boundaries: number[] = [];
  let start = 0;
  for (const match of source.matchAll(EDITORIAL_BLOCK_BOUNDARY_RE)) {
    const index = match.index;
    const previous = source[index - 1];
    const candidate = source.slice(start, index).trim();
    const candidateWords = candidate.split(/\s+/u);
    const lastCandidateWord = candidateWords.at(-1) ?? "";
    const sentenceBoundary = previous !== undefined && /[.!?]/u.test(previous);
    const headingBoundary =
      candidate.length <= EDITORIAL_HEADING_MAX_CHARS &&
      candidateWords.length >= 2 &&
      /^\p{Ll}{2,}$/u.test(lastCandidateWord) &&
      !TERMINAL_PUNCTUATION_RE.test(candidate);
    if (!sentenceBoundary && !headingBoundary) {
      continue;
    }
    boundaries.push(index);
    start = index;
  }

  const blocks: EditorialSupplementBlock[] = [];
  let blockStart = 0;
  for (const boundary of [...boundaries, source.length]) {
    const block = editorialBlock(source, blockStart, boundary);
    if (block !== null) {
      blocks.push(block);
    }
    blockStart = boundary;
  }
  return blocks;
};

/** Search-piece ids for publisher text the reader renders from a field. */
const SUPPLEMENT_LEGAL_SENTENCE_ID = "supplement-legal-sentence";
const SUPPLEMENT_ABSTRACT_ID = "supplement-abstract";
const SUPPLEMENT_SUMMARY_ID = "supplement-summary";

/** The two named sections the reader opens a decision with. */
type TopMatterSection = "abstract" | "legalSentence";

/**
 * Which section each publisher-summary role opens the decision in.
 *
 * The roles are the AST package's own list, the one the API resolves a
 * result row's headnote over before it reads any metadata key: a parser that
 * marked the paragraph beats a copied-out field, because the text is the
 * publisher's own, in document order, and it keeps its block ids — so search
 * ranges, annotation anchors and permalinks go on working. The map is total
 * over that list, so a role added there cannot reach the reader without a
 * decision about where it belongs.
 */
const TOP_MATTER_SECTION_BY_ROLE = {
  headnotes: "legalSentence",
  summary: "abstract",
  syllabus: "abstract",
} as const satisfies Record<PublisherSummaryRole, TopMatterSection>;

const rolesForSection = (
  section: TopMatterSection,
): readonly PublisherSummaryRole[] =>
  PUBLISHER_SUMMARY_ROLES.filter(
    (role) => TOP_MATTER_SECTION_BY_ROLE[role] === section,
  );

/** Where a section's text comes from: the document itself, or a field. */
export type TopMatterSource =
  | { type: "blocks"; blocks: ParagraphBlock[] }
  | { type: "text"; pieceId: string; text: string };

export type DecisionTopMatter = {
  abstract: TopMatterSource | null;
  legalSentence: TopMatterSource | null;
  /**
   * The blocks the top matter took out of the body. The document must not
   * render them a second time, and the apparatus disclosure below is left
   * with what is neither headnote nor abstract: counsel, and unnamed
   * publisher matter.
   */
  liftedBlockIds: ReadonlySet<string>;
};

/** A present field's text, or null when the publisher filed none. */
const decisionTextFieldText = (field: TextField): string | null => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return null;
    case TEXT_FIELD_TYPE.PRESENT:
      return field.text;
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

const paragraphsWithRole = (
  blocks: readonly Block[],
  roles: readonly PublisherSummaryRole[],
): ParagraphBlock[] => {
  const wanted = new Set<string>(roles);
  return blocks.filter(
    (block): block is ParagraphBlock =>
      block.type === "paragraph" &&
      isHeadMatterBlock(block) &&
      block.role !== undefined &&
      wanted.has(block.role),
  );
};

const blockSource = (blocks: ParagraphBlock[]): TopMatterSource | null =>
  blocks.length === 0 ? null : { blocks, type: "blocks" };

const textSource = (
  pieceId: string,
  field: TextField,
): TopMatterSource | null => {
  const text = decisionTextFieldText(field);
  return text === null ? null : { pieceId, text, type: "text" };
};

const firstAvailable = (
  candidates: readonly (TopMatterSource | null)[],
): TopMatterSource | null =>
  candidates.find((candidate) => candidate !== null) ?? null;

/**
 * What the reader shows above the decision: the headnote it is cited by, and
 * the publisher's abstract of it.
 *
 * The sources, best first, are the ones the results table's headnote resolves
 * over, so a decision that shows a headnote in the table shows one here too.
 * Within a section the marked-up paragraphs win over the fields copied out of
 * the same publisher payload, and a field is read only where the parser marked
 * nothing.
 */
export const decisionTopMatter = ({
  blocks,
  textFields,
}: {
  blocks: readonly Block[];
  textFields: ReadDecisionTextFields;
}): DecisionTopMatter => {
  const legalSentence = firstAvailable([
    blockSource(paragraphsWithRole(blocks, rolesForSection("legalSentence"))),
    textSource(
      SUPPLEMENT_LEGAL_SENTENCE_ID,
      textFields[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
    ),
    textSource(SUPPLEMENT_SUMMARY_ID, textFields[DECISION_TEXT_FIELD.SUMMARY]),
  ]);
  const abstract = firstAvailable([
    blockSource(paragraphsWithRole(blocks, rolesForSection("abstract"))),
    textSource(
      SUPPLEMENT_ABSTRACT_ID,
      textFields[DECISION_TEXT_FIELD.ABSTRACT],
    ),
  ]);

  const liftedBlockIds = new Set<string>();
  for (const source of [legalSentence, abstract]) {
    if (source?.type !== "blocks") {
      continue;
    }
    for (const block of source.blocks) {
      liftedBlockIds.add(block.id);
    }
  }

  return { abstract, legalSentence, liftedBlockIds };
};

/** The anchor a block of publisher field text is drawn and marked under. */
export const supplementBlockAnchorId = (
  pieceId: string,
  start: number,
): string => `${pieceId}:${String(start)}`;

/**
 * Every anchored run of text the decision reader draws marks in, in reading
 * order: the headnote and abstract where they come from a publisher field,
 * then the document's blocks, or its plain-text paragraphs when it has none.
 * A stored mark is placed by its words among these, so a run the reader
 * draws and this list misses is a mark reported as orphaned, never one drawn
 * elsewhere.
 */
export const decisionReaderTextPieces = (
  decision: ReaderTextDecision,
): ReaderTextPiece[] => {
  const ast = parseDocumentAst(decision.documentAst);
  const topMatter = decisionTopMatter({
    blocks: visibleDecisionBlocks(ast, decision.caseNumberType),
    textFields: decision.textFields,
  });
  const supplements = [topMatter.legalSentence, topMatter.abstract].flatMap(
    (source) =>
      source?.type === "text"
        ? editorialSupplementBlocks(source.text).map((block) => ({
            anchorId: supplementBlockAnchorId(source.pieceId, block.start),
            text: block.text,
          }))
        : [],
  );
  return [
    ...supplements,
    ...visibleDecisionBlocks(
      ast,
      decision.caseNumberType,
      decision.fulltext,
    ).flatMap(readerAnchorPiecesOf),
  ];
};

/**
 * The blocks the top matter draws, in the order it draws them: the headnote,
 * then the abstract. Whatever counts positions — match numbering, note
 * grouping, the landing passage — reads the decision through this order
 * followed by the body, which is what the page actually shows.
 */
export const topMatterBlocks = (
  topMatter: DecisionTopMatter,
): ParagraphBlock[] =>
  [topMatter.legalSentence, topMatter.abstract].flatMap((source) =>
    source?.type === "blocks" ? source.blocks : [],
  );
