import { isCaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ProvisionPlacementFailure } from "@stll/api-contract/provision-placement";
import {
  CZ_CAPTION_FORMS,
  detectDecisionCaption,
  SK_CAPTION_FORMS,
} from "@stll/legal-ast/decision-caption";
import type {
  CaptionForms,
  DecisionCaption,
} from "@stll/legal-ast/decision-caption";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionPrimaryReferenceType } from "@stll/legal-ast/decision-identifier";
import { isHeadMatterBlock } from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  ParagraphBlock,
} from "@stll/legal-ast/document-ast";
import {
  LINE_CONTINUATION_SEPARATOR,
  planBlockLineWrap,
} from "@stll/legal-ast/line-wrap";
import { dropOverlappingSpans } from "@stll/legal-ast/text-spans";

import type { HeadnoteOrigin } from "./headnote-block";
import type { ReaderDecision } from "./reader-types";

/** Account for provision links displaced by any other kind of rendered link. */
export const resolveDecisionLinkOverlaps = <
  T extends { key: string; start: number; end: number },
>(
  anchors: readonly T[],
) => {
  const links = dropOverlappingSpans(anchors);
  const retained = new Set(links);
  const failures: ProvisionPlacementFailure[] = [];
  for (const anchor of anchors) {
    if (anchor.key.startsWith("provision:") && !retained.has(anchor)) {
      failures.push({
        id: anchor.key.slice("provision:".length),
        reason: "span-overlap",
      });
    }
  }
  return { links, failures };
};

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
}: Pick<ReaderDecision, "courtAbbreviation" | "courtTier">): HeadnoteOrigin =>
  courtAbbreviation !== null && courtAbbreviation !== ""
    ? {
        type: "court",
        chip: { abbreviation: courtAbbreviation, tier: courtTier },
      }
    : { type: "court", chip: null };

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
 * The reference the reader's reference line shows. For a docket primary, the
 * document's own case-number header wins, since it keeps the court's printed
 * spelling. Any other primary (a reporter or neutral citation) is shown as
 * stored: the document's header is then the docket, which stays visible in
 * the text itself and must not displace the citation.
 */
export const decisionDisplayReference = ({
  ast,
  caseNumber,
  caseNumberType,
}: {
  ast: DocumentAst | null;
  caseNumber: string;
  caseNumberType: DecisionPrimaryReferenceType;
}): string => {
  if (caseNumberType !== DECISION_IDENTIFIER_TYPES.CASE_NUMBER) {
    return caseNumber;
  }
  const caseNumberBlock = ast?.blocks.find(
    (block) => block.type === "paragraph" && block.role === "case-number",
  );
  return caseNumberBlock?.plainText ?? caseNumber;
};

/** The blocks the reader folds behind the head-matter disclosure. */
export const apparatusBlockIds = (
  blocks: readonly Block[],
): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (isHeadMatterBlock(block)) {
      ids.add(block.id);
    }
  }
  return ids;
};

const footnoteBlock = (block: Block | undefined) =>
  (block?.type === "paragraph" || block?.type === "table") &&
  block.note?.type === "footnote"
    ? block
    : null;

/**
 * Whether `block` continues the footnote `previous` opened: the two are
 * adjacent parts of one note when both are footnote blocks sharing a
 * `noteId`. A footnote block without one is complete by itself, so it
 * neither continues its neighbour nor is continued by it.
 */
const continuesFootnote = (
  previous: Block | undefined,
  block: Block | undefined,
): boolean => {
  const noteId = footnoteBlock(previous)?.note?.noteId;
  return noteId !== undefined && footnoteBlock(block)?.note?.noteId === noteId;
};

/**
 * Where each footnote begins and ends, by block id.
 *
 * A footnote printed over several blocks is several adjacent
 * paragraphs or tables sharing one `noteId`; the reader draws the note's mark once
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
    if (footnoteBlock(block) === null) {
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

/** Paragraph blocks the reader draws as one paragraph, each keeping its anchor. */
export type WrappedParagraphRun = {
  blocks: [ParagraphBlock, ...ParagraphBlock[]];
  /** `separators[i]` is drawn between `blocks[i]` and `blocks[i + 1]`. */
  separators: string[];
};

export type WrappedParagraphRuns = {
  byHeadId: ReadonlyMap<string, WrappedParagraphRun>;
  /** Blocks drawn inside the run of an earlier block, not on their own. */
  continuationIds: ReadonlySet<string>;
};

/**
 * The runs of a hard-wrapped decision's line blocks that the reader joins
 * back into paragraphs. Planned over the blocks in document order, so a
 * block the top matter lifts out still breaks the runs around it; for a
 * document that is not fixed-width wrapped there are none.
 *
 * A fallback for rows stored before their parser rebuilt paragraphs at
 * ingestion, deleted with the planner once the corpus is re-parsed (see
 * `@stll/legal-ast/line-wrap`).
 */
export const wrappedParagraphRuns = (
  blocks: readonly Block[],
): WrappedParagraphRuns => {
  const { continuations } = planBlockLineWrap(blocks);
  const byHeadId = new Map<string, WrappedParagraphRun>();
  const continuationIds = new Set<string>();
  let run: WrappedParagraphRun | null = null;
  for (const block of blocks) {
    const continuation = continuations.get(block.id);
    if (block.type !== "paragraph") {
      run = null;
      continue;
    }
    if (continuation === undefined || run === null) {
      run = { blocks: [block], separators: [] };
      continue;
    }
    if (run.blocks.length === 1) {
      byHeadId.set(run.blocks[0].id, run);
    }
    run.blocks.push(block);
    run.separators.push(LINE_CONTINUATION_SEPARATOR[continuation]);
    continuationIds.add(block.id);
  }
  return { byHeadId, continuationIds };
};

/**
 * Each jurisdiction's caption vocabulary, or `null` where its courts print
 * no caption of that shape and a decision is drawn block by block as stored.
 * Total, so a new jurisdiction cannot arrive without that decision.
 */
const CAPTION_FORMS_BY_JURISDICTION = {
  AUT: null,
  CZE: CZ_CAPTION_FORMS,
  EU: null,
  GBR: null,
  HUN: null,
  POL: null,
  SVK: SK_CAPTION_FORMS,
  USA: null,
} as const satisfies Record<CaseLawJurisdiction, CaptionForms | null>;

/**
 * The caption the body opens with, drawn as the centred header the court
 * printed instead of as the run-on line it is stored as. A stored country no
 * jurisdiction declares has no vocabulary to read a caption with; its blocks
 * are drawn as stored, which loses nothing.
 */
export const decisionCaption = ({
  blocks,
  country,
}: {
  blocks: readonly Block[];
  country: string;
}): DecisionCaption | null => {
  if (!isCaseLawJurisdiction(country)) {
    return null;
  }
  const forms = CAPTION_FORMS_BY_JURISDICTION[country];
  return forms === null ? null : detectDecisionCaption(blocks, forms);
};
