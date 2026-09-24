import { panic } from "better-result";

import {
  DECISION_TEXT_FIELD,
  TEXT_FIELD_TYPE,
  type ReadDecisionTextFields,
  type TextField,
} from "@stll/api-contract/case-law-text-field";
import { caseLawSectionHeading } from "@stll/legal-ast/case-law-heading";
import {
  PUBLISHER_SUMMARY_ROLES,
  isApparatusRole,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
  PublisherSummaryRole,
} from "@stll/legal-ast/document-ast";

import type { HeadnoteOrigin } from "@/features/case-law/components/case-viewer/headnote-block";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";

/**
 * The mark the court's own top matter carries: the court's chip where the
 * read abbreviated it, and its name in words everywhere else.
 *
 * No chip is invented for a court the registry did not answer for: the read
 * then states no abbreviation and a placeholder tier (`courtPresentation`).
 * The chip is drawn from the tier, so a guessed one would show a rank nobody
 * stated, and the alternative costs the reader nothing: the court's name
 * stands in the reference line above either way.
 */
export const courtHeadnoteOrigin = ({
  courtAbbreviation,
  courtTier,
}: Pick<
  PublicCaseLawDecision,
  "courtAbbreviation" | "courtTier"
>): HeadnoteOrigin =>
  courtAbbreviation !== null && courtAbbreviation !== ""
    ? {
        type: "court",
        chip: { abbreviation: courtAbbreviation, tier: courtTier },
      }
    : { type: "court", chip: null };

export type EditorialSupplementBlock = {
  end: number;
  start: number;
  text: string;
  type: "heading" | "paragraph";
};

type AnnotationOffsetSpan = {
  endOffset: number;
  startOffset: number;
};

type TextOffsetSpan = {
  end: number;
  start: number;
};

/**
 * The reader keeps links interactive inside a marked passage. Every mark
 * intersecting the link must therefore be painted inside the link as well;
 * otherwise the citation cuts a white hole through one continuous mark.
 */
export const annotationsOverlappingTextSpan = <T extends AnnotationOffsetSpan>(
  annotations: readonly T[],
  span: TextOffsetSpan,
): T[] =>
  annotations.filter(
    (annotation) =>
      annotation.startOffset < span.end && span.start < annotation.endOffset,
  );

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

/**
 * The case's citable name, for the citation a copied passage carries. Only a
 * title of the "Name, Cite" shape yields one: a generic heading ("JUDGMENT OF
 * THE COURT (Grand Chamber)", a bare case number) must not masquerade as a
 * case name.
 */
export const decisionCaseName = ({
  ast,
  caseNumber,
}: {
  ast: DocumentAst | null;
  caseNumber: string;
}): string | null => {
  const title = ast?.blocks.find(
    (block) => block.type === "heading" && block.role === "decision-title",
  )?.plainText;
  const citeSuffix = `, ${caseNumber}`;
  return title?.endsWith(citeSuffix) === true
    ? title.slice(0, -citeSuffix.length)
    : null;
};

/**
 * Remove structural metadata that the reader renders elsewhere. Content is
 * never hidden by matching its words: a court's title and constitutional
 * formula are part of the decision and remain visible as AST headings.
 */
export const visibleDecisionBlocks = (ast: DocumentAst | null): Block[] => {
  if (ast === null) {
    return [];
  }

  const visible: Block[] = [];
  let inReasoning = false;
  for (const block of ast.blocks) {
    if (
      (block.type === "paragraph" && block.role === "case-number") ||
      (block.type === "table" && block.role === "related-proceedings")
    ) {
      continue;
    }
    if (
      block.type === "heading" &&
      /^Odůvodnění\s*:?$/iu.test(block.plainText)
    ) {
      inReasoning = true;
    }
    if (inReasoning && block.type === "paragraph" && block.role === undefined) {
      const heading = caseLawSectionHeading(block.plainText);
      if (heading !== null) {
        visible.push({
          anchorId: block.anchorId,
          id: block.id,
          inlines: block.inlines,
          level: heading.level,
          plainText: block.plainText,
          type: "heading",
        });
        continue;
      }
    }
    visible.push(block);
  }
  return visible;
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

/** The blocks the reader folds behind the head-matter disclosure. */
export const apparatusBlockIds = (
  blocks: readonly Block[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === "paragraph" && isApparatusRole(block.role)) {
      ids.add(block.id);
    }
  }
  return ids;
};

const footnoteParagraph = (block: Block | undefined): ParagraphBlock | null =>
  block?.type === "paragraph" && block.note?.type === "footnote" ? block : null;

/**
 * Whether `block` continues the footnote `previous` opened: the two are
 * adjacent parts of one note when both are footnote paragraphs sharing a
 * `noteId`. A footnote paragraph without one is complete by itself, so it
 * neither continues its neighbour nor is continued by it.
 */
const continuesFootnote = (
  previous: Block | undefined,
  block: Block | undefined,
): boolean => {
  const noteId = footnoteParagraph(previous)?.note?.noteId;
  return (
    noteId !== undefined && footnoteParagraph(block)?.note?.noteId === noteId
  );
};

/**
 * Where each footnote begins and ends, by block id.
 *
 * A footnote printed over several paragraphs is several adjacent
 * paragraphs sharing one `noteId`; the reader draws the note's mark once
 * at the start and the return arrow once at the end, the way the printed
 * page does, instead of repeating both on every part.
 */
export type FootnoteParts = {
  headIds: ReadonlySet<string>;
  /**
   * The footnote's head anchor, keyed by the id of its last block: the
   * return arrow sits on the last part but jumps back from the head, which
   * is the anchor the in-text reference points at.
   */
  backJumpAnchorByLastId: ReadonlyMap<string, string>;
};

export const footnoteParts = (blocks: readonly Block[]): FootnoteParts => {
  const headIds = new Set<string>();
  const backJumpAnchorByLastId = new Map<string, string>();
  let headAnchor: string | null = null;
  for (const [index, block] of blocks.entries()) {
    if (footnoteParagraph(block) === null) {
      continue;
    }
    if (!continuesFootnote(blocks[index - 1], block)) {
      headIds.add(block.id);
      headAnchor = block.anchorId;
    }
    if (!continuesFootnote(block, blocks[index + 1])) {
      backJumpAnchorByLastId.set(block.id, headAnchor ?? block.anchorId);
    }
  }
  return { headIds, backJumpAnchorByLastId };
};
