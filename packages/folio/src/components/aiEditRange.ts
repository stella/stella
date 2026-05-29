/**
 * Helpers shared by the AI-edit imperative API methods.
 *
 * Lives outside `DocxEditor.tsx` so the bounds-checking logic that protects
 * `TextSelection.between` from "endpoint not pointing into a node with
 * inline content" can be unit-tested without spinning up a real PM view.
 */

import type { Node as PMNode } from "prosemirror-model";

import { createFolioAIEditSnapshot } from "../core/ai-edits/snapshot";
import type { FolioAIEditSnapshot } from "../core/ai-edits/types";
import { findParagraphByParaId } from "../core/prosemirror/utils/findParagraphByParaId";
import { getFolioParaIdFromBlockId } from "../core/types/block-id";

export type DocPositionRange = { from: number; to: number };

type ResolveFolioAIBlockRangeOptions = {
  blockId: string;
  doc: PMNode;
  snapshot?: FolioAIEditSnapshot | null | undefined;
};

const LEGACY_BLOCK_ID_PATTERN = /^b-(\d+)$/u;

/**
 * Walk the document in order and return the range for the Nth (1-indexed)
 * textblock. Used as the resolution path for the legacy `b-NNNN` block-id
 * shape: those ids are a zero-padded 1-based document-order counter from
 * before {@link deriveBlockId} unified the on-disk format, so the only
 * way to resolve a row that was persisted under one is to count.
 */
const findTextblockByDocumentOrder = (
  doc: PMNode,
  oneBasedIndex: number,
): DocPositionRange | null => {
  if (oneBasedIndex < 1) {
    return null;
  }
  let seen = 0;
  let result: DocPositionRange | null = null;
  doc.descendants((node, pos) => {
    if (result !== null) {
      return false;
    }
    if (!node.isTextblock) {
      return true;
    }
    seen += 1;
    if (seen === oneBasedIndex) {
      result = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return false;
  });
  return result;
};

export const resolveFolioAIBlockRange = ({
  blockId,
  doc,
  snapshot,
}: ResolveFolioAIBlockRangeOptions): DocPositionRange | null => {
  const paraId = getFolioParaIdFromBlockId(blockId);
  if (paraId !== null) {
    const liveRange = findParagraphByParaId(doc, paraId);
    if (liveRange !== null) {
      return { from: liveRange.from, to: liveRange.to };
    }
  }

  const resolvedSnapshot = snapshot ?? createFolioAIEditSnapshot(doc);
  const anchor = resolvedSnapshot.anchors[blockId];
  if (anchor) {
    return clampRangeToDocSize(doc.content.size, anchor);
  }

  // Legacy fallback: citations persisted under the pre-deriveBlockId
  // `b-NNNN` scheme don't appear in the live paraId set or the
  // snapshot's anchor map. The number is a 1-based document-order
  // counter, so resolving by ordinal lands on the same paragraph
  // the original extraction was anchored to.
  const legacyMatch = LEGACY_BLOCK_ID_PATTERN.exec(blockId);
  if (legacyMatch) {
    const oneBasedIndex = Number.parseInt(legacyMatch[1] ?? "0", 10);
    const range = findTextblockByDocumentOrder(doc, oneBasedIndex);
    if (range !== null) {
      return clampRangeToDocSize(doc.content.size, range);
    }
  }

  return null;
};

/**
 * Clamp a `{from, to}` pair so both endpoints fit inside a document of
 * `docSize` (in PM content positions). Block-boundary snapshots and stale
 * range data sometimes produce a `to` one past the last inline position;
 * `view.state.doc.resolve(...)` rejects that with
 * "Position … out of range", and `TextSelection.between` doesn't help — it
 * needs *valid* resolved positions. Clamping before resolution is the cheap
 * defensive step.
 *
 * Order is preserved: if both endpoints exceed `docSize`, the returned
 * `from` may equal `to`, yielding a cursor selection at the doc end.
 */
export function clampRangeToDocSize(
  docSize: number,
  range: DocPositionRange,
): DocPositionRange {
  return {
    from: Math.min(Math.max(range.from, 0), docSize),
    to: Math.min(Math.max(range.to, 0), docSize),
  };
}
