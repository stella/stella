import { panic } from "better-result";

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

export type ProseSegment =
  | { type: "plain"; text: string }
  | { type: "claim"; text: string; claim: VerificationClaim };

export type ProseBlock = {
  ordinal: number;
  pageNumber: number | null;
  segments: ProseSegment[];
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

/** Partition stored text without changing its UTF-16 offsets or repeating overlap. */
export const segmentProseBlock = (
  block: VerificationBlock,
  claims: readonly VerificationClaim[],
): ProseSegment[] => {
  const segments: ProseSegment[] = [];
  const anchored = claims
    .filter((claim) => claimBelongsToBlock(claim, block))
    .toSorted(
      (a, b) =>
        a.anchor.start - b.anchor.start ||
        b.anchor.end - a.anchor.end ||
        a.position - b.position ||
        a.id.localeCompare(b.id),
    );
  let cursor = 0;
  for (const claim of anchored) {
    const start = Math.max(cursor, claim.anchor.start);
    const end = Math.min(block.text.length, claim.anchor.end);
    if (start >= end) {
      continue;
    }
    if (start > cursor) {
      segments.push({ type: "plain", text: block.text.slice(cursor, start) });
    }
    segments.push({ type: "claim", text: block.text.slice(start, end), claim });
    cursor = end;
  }
  if (cursor < block.text.length) {
    segments.push({ type: "plain", text: block.text.slice(cursor) });
  }
  return segments;
};

export const segmentProse = (
  blocks: readonly VerificationBlock[],
  claims: readonly VerificationClaim[],
): ProseBlock[] =>
  blocks
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((block) => ({
      ordinal: block.ordinal,
      pageNumber: block.kind === "pdf-page" ? block.pageNumber : null,
      segments: segmentProseBlock(block, claims),
    }));

export const proseReadingOrder = (
  blocks: readonly ProseBlock[],
): VerificationClaim["id"][] =>
  blocks.flatMap((block) =>
    block.segments.flatMap((segment) =>
      segment.type === "claim" ? [segment.claim.id] : [],
    ),
  );
