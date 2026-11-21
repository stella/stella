/**
 * Where a verification's claims sit in the original DOCX as Folio lays it out,
 * and how the painted pages are marked and clicked.
 *
 * The server read the document through Folio's own block snapshot, so a
 * claim's block id and UTF-16 offsets index the same clean block text the
 * live editor resolves stable text ranges against. A claim resolves only when
 * the block is found and its words still hash to what the run stored; any
 * other claim is reported rather than drawn somewhere near.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import {
  createFolioAIEditSnapshot,
  createFolioAITextRangeHandle,
  resolveFolioAITextRange,
} from "@stll/folio-core/ai-edits";
import type { TextMarkState } from "@stll/ui/text-mark";

import type {
  ClaimState,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";

type VerificationBlock = VerificationRun["blocks"][number];
type ClaimId = VerificationClaim["id"];

/** One claim's words as a ProseMirror range of the original. */
export type LocatedClaim = {
  claimId: ClaimId;
  blockId: string;
  from: number;
  to: number;
};

export type ClaimLocations = {
  located: LocatedClaim[];
  /** Claims with no place in the original, in reading order. */
  unlocated: ClaimId[];
};

type LocateClaimsArgs = {
  doc: ProseMirrorNode;
  blocks: readonly VerificationBlock[];
  claims: readonly Pick<VerificationClaim, "id" | "position" | "anchor">[];
};

/**
 * Resolve every claim against the document Folio loaded. The run's stored
 * block text is what the offsets index, so it is what the range handle
 * hashes: a block the editor reads differently (a different file, a parser
 * change) fails the hash and the claim is reported as not located.
 */
export const locateClaimsInDocument = ({
  doc,
  blocks,
  claims,
}: LocateClaimsArgs): ClaimLocations => {
  const snapshot = createFolioAIEditSnapshot(doc);
  const textByBlockId = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind === "docx-block") {
      textByBlockId.set(block.blockId, block.text);
    }
  }
  const located: LocatedClaim[] = [];
  const unlocated: ClaimId[] = [];
  for (const claim of claims.toSorted((a, b) => a.position - b.position)) {
    const { anchor } = claim;
    if (anchor.type !== "docx-block") {
      unlocated.push(claim.id);
      continue;
    }
    const text = textByBlockId.get(anchor.blockId);
    const handle =
      text === undefined
        ? null
        : createFolioAITextRangeHandle({
            blockId: anchor.blockId,
            text,
            startOffset: anchor.start,
            endOffset: anchor.end,
          });
    const range =
      handle === null
        ? null
        : resolveFolioAITextRange({ range: handle, doc, snapshot });
    if (range === null || range.from >= range.to) {
      unlocated.push(claim.id);
      continue;
    }
    located.push({
      claimId: claim.id,
      blockId: anchor.blockId,
      from: range.from,
      to: range.to,
    });
  }
  return { located, unlocated };
};

/** A painted text run and the ProseMirror positions it draws. */
export type PaintedSpan = { pmStart: number; pmEnd: number };

/** The characters of one painted run a range covers. */
export type PaintedSegment = {
  spanIndex: number;
  start: number;
  end: number;
};

/**
 * The painted runs a ProseMirror range crosses, each with the character
 * offsets inside the run's own text. A run's characters are its positions in
 * order, so the offsets are distances from the run's start position.
 */
export const paintedSegments = (
  spans: readonly PaintedSpan[],
  range: { from: number; to: number },
): PaintedSegment[] => {
  const segments: PaintedSegment[] = [];
  for (const [spanIndex, span] of spans.entries()) {
    if (span.pmEnd <= range.from || span.pmStart >= range.to) {
      continue;
    }
    const start = Math.max(0, range.from - span.pmStart);
    const end = Math.min(span.pmEnd - span.pmStart, range.to - span.pmStart);
    if (start < end) {
      segments.push({ spanIndex, start, end });
    }
  }
  return segments;
};

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The claim under a point. Where marks overlap, the smallest one is the claim
 * the reader most plausibly meant.
 */
export const claimAtPoint = (
  boxesByClaim: ReadonlyMap<ClaimId, readonly Box[]>,
  point: { x: number; y: number },
): ClaimId | null => {
  let best: { id: ClaimId; area: number } | null = null;
  for (const [id, boxes] of boxesByClaim) {
    const hit = boxes.some(
      (box) =>
        point.x >= box.left &&
        point.x <= box.right &&
        point.y >= box.top &&
        point.y <= box.bottom,
    );
    if (!hit) {
      continue;
    }
    const area = boxes.reduce(
      (sum, box) => sum + (box.right - box.left) * (box.bottom - box.top),
      0,
    );
    if (best === null || area < best.area) {
      best = { id, area };
    }
  }
  return best?.id ?? null;
};

/** The registered highlight a claim of this verdict and mark paints into. */
export const claimHighlightName = (
  scope: string,
  state: ClaimState,
  mark: TextMarkState,
): string =>
  `stella-avt-claim-${scope.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}-${state}-${mark}`;
