import { panic } from "better-result";

import type { ParagraphBlock } from "@stll/legal-ast/document-ast";
import type { TextMarkState } from "@stll/ui/text-mark";

import type {
  ClaimAnchor,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";

/**
 * Pure presentation logic for a claim span in the document view. Takes only
 * the two facts that determine the answer (whether THIS claim matches the
 * active filter, and whether a filter is active at all) so a caller cannot
 * compute "matches" once per passage and apply it to every claim in it.
 */
export const spanPresentation = ({
  matches,
  filterActive,
}: {
  matches: boolean;
  filterActive: boolean;
}): { dim: boolean; highlight: boolean } => ({
  dim: filterActive && !matches,
  highlight: filterActive && matches,
});

/**
 * How one claim is marked over the original document: the selected claim is
 * active, a claim the active filter matches is picked out, and a claim the
 * filter leaves out is not drawn (a highlight cannot fade its words the way
 * the reading view dims them).
 */
export const claimMark = ({
  selected,
  dim,
  highlight,
}: {
  selected: boolean;
  dim: boolean;
  highlight: boolean;
}): TextMarkState | null => {
  if (selected) {
    return "active";
  }
  if (dim) {
    return null;
  }
  return highlight ? "matched" : "rest";
};

/**
 * Which original the claims can be laid over: a DOCX read through Folio
 * (block ids), or a PDF read page by page (page text offsets). A run with no
 * stored text, or a mix the server never writes, has none.
 */
export const originalKind = (
  blocks: readonly Pick<VerificationRun["blocks"][number], "kind">[],
): "docx" | "pdf" | null => {
  if (blocks.length === 0) {
    return null;
  }
  if (blocks.every((block) => block.kind === "docx-block")) {
    return "docx";
  }
  if (blocks.every((block) => block.kind === "pdf-page")) {
    return "pdf";
  }
  return null;
};

/**
 * A run of claims that sit in the same DOCX block or on the same PDF page,
 * in reading order. The run stores each claim's own words and where they sit,
 * not the text around them, so the document pane renders these passages
 * rather than the full document.
 */
export type ClaimPassage = {
  key: string;
  /** The block or page every claim of the passage is anchored in. */
  anchorKey: string;
  /** The PDF page the passage is on; null for a DOCX block. */
  pageNumber: number | null;
  claims: VerificationClaim[];
};

const anchorKey = (anchor: ClaimAnchor): string => {
  switch (anchor.type) {
    case "docx-block": {
      return `block:${anchor.blockId}`;
    }
    case "pdf-page": {
      return `page:${String(anchor.pageNumber)}`;
    }
    default: {
      anchor satisfies never;
      return panic(`Unhandled claim anchor: ${String(anchor)}`);
    }
  }
};

/**
 * Group claims into passages. Claims arrive in reading order (`position`);
 * consecutive claims anchored in the same block or page share a passage, and
 * within it they are ordered by where they start.
 */
export const groupClaimsIntoPassages = (
  claims: readonly VerificationClaim[],
): ClaimPassage[] => {
  const passages: ClaimPassage[] = [];
  const ordered = claims.toSorted((a, b) => a.position - b.position);
  for (const claim of ordered) {
    const key = anchorKey(claim.anchor);
    const last = passages.at(-1);
    if (last?.anchorKey === key) {
      last.claims.push(claim);
      continue;
    }
    passages.push({
      key: `${key}#${String(passages.length)}`,
      anchorKey: key,
      pageNumber:
        claim.anchor.type === "pdf-page" ? claim.anchor.pageNumber : null,
      claims: [claim],
    });
  }
  for (const passage of passages) {
    passage.claims.sort((a, b) => a.anchor.start - b.anchor.start);
  }
  return passages;
};

/** Claim ids in the order the document pane shows them. */
export const passageReadingOrder = (
  passages: readonly ClaimPassage[],
): VerificationClaim["id"][] =>
  passages.flatMap((passage) => passage.claims.map((claim) => claim.id));

type VerificationBlock = VerificationRun["blocks"][number];

/**
 * Where one claim is marked in its block's text. Offsets index the stored
 * text (UTF-16), which is also the reader paragraph's plain text, so they
 * are the reader's anchor offsets unchanged.
 */
export type ClaimSpan = {
  claim: VerificationClaim;
  start: number;
  end: number;
};

/**
 * A stored block as the document pane shows it: the shared reader's
 * paragraph for its text, and the claims marked in it.
 */
export type ProseBlock = {
  ordinal: number;
  pageNumber: number | null;
  /** Piece and anchor id are the AVT block id. */
  paragraph: ParagraphBlock;
  claimSpans: ClaimSpan[];
};

const claimBelongsToBlock = (
  claim: VerificationClaim,
  block: VerificationBlock,
): boolean => {
  switch (block.kind) {
    case "docx-block": {
      return (
        claim.anchor.type === "docx-block" &&
        claim.anchor.blockId === block.blockId
      );
    }
    case "pdf-page": {
      return (
        claim.anchor.type === "pdf-page" &&
        claim.anchor.pageNumber === block.pageNumber
      );
    }
    default: {
      block.kind satisfies never;
      return panic(`Unhandled verification block kind: ${String(block.kind)}`);
    }
  }
};

/**
 * The claims of one block as ordered, non-overlapping spans of its text: the
 * earliest claim wins, then the longest; a later claim keeps only what an
 * earlier one left, and one left with nothing is not marked. The reader
 * requires the anchors of one piece not to overlap.
 */
export const claimSpansForBlock = (
  block: VerificationBlock,
  claims: readonly VerificationClaim[],
): ClaimSpan[] => {
  const spans: ClaimSpan[] = [];
  const anchored = claims
    .filter((claim) => claimBelongsToBlock(claim, block))
    .toSorted(
      (a, b) =>
        a.anchor.start - b.anchor.start ||
        b.anchor.end - a.anchor.end ||
        a.position - b.position,
    );
  let cursor = 0;
  for (const claim of anchored) {
    const start = Math.max(cursor, claim.anchor.start);
    const end = Math.min(block.text.length, claim.anchor.end);
    if (start >= end) {
      continue;
    }
    spans.push({ claim, start, end });
    cursor = end;
  }
  return spans;
};

/**
 * The block's text as a reader paragraph, the shape the reader's own
 * full-text fallback builds. The text stays one run, line breaks included
 * (the pane preserves them with `white-space`): the reader draws an anchor
 * once per text run, so a claim that crosses a line stays one mark, and the
 * paragraph's plain text is the stored text, so claim offsets need no
 * translation.
 */
export const readerParagraph = (block: VerificationBlock): ParagraphBlock => ({
  id: block.blockId,
  anchorId: block.blockId,
  type: "paragraph",
  plainText: block.text,
  inlines: [{ type: "text", text: block.text }],
});

export const segmentProse = (
  blocks: readonly VerificationBlock[],
  claims: readonly VerificationClaim[],
): ProseBlock[] =>
  blocks
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((block) => ({
      ordinal: block.ordinal,
      pageNumber: block.kind === "pdf-page" ? block.pageNumber : null,
      paragraph: readerParagraph(block),
      claimSpans: claimSpansForBlock(block, claims),
    }));

export const proseReadingOrder = (
  blocks: readonly ProseBlock[],
): VerificationClaim["id"][] =>
  blocks.flatMap((block) => block.claimSpans.map((span) => span.claim.id));

export type ClaimPresentation =
  | {
      type: "prose";
      blocks: ProseBlock[];
      readingOrder: VerificationClaim["id"][];
    }
  | {
      type: "passages";
      passages: ClaimPassage[];
      readingOrder: VerificationClaim["id"][];
    };

/** Use segmented source text only when it preserves every claim. */
export const selectClaimPresentation = (
  blocks: readonly VerificationBlock[],
  claims: readonly VerificationClaim[],
): ClaimPresentation => {
  const prose = segmentProse(blocks, claims);
  const proseOrder = proseReadingOrder(prose);
  const proseClaimIds = new Set(proseOrder);
  if (
    prose.length > 0 &&
    proseClaimIds.size === claims.length &&
    claims.every((claim) => proseClaimIds.has(claim.id))
  ) {
    return { type: "prose", blocks: prose, readingOrder: proseOrder };
  }

  const passages = groupClaimsIntoPassages(claims);
  return {
    type: "passages",
    passages,
    readingOrder: passageReadingOrder(passages),
  };
};
