/**
 * Helpers shared by the AI-edit imperative API methods.
 *
 * Lives outside `DocxEditor.tsx` so the bounds-checking logic that protects
 * `TextSelection.between` from "endpoint not pointing into a node with
 * inline content" can be unit-tested without spinning up a real PM view.
 */

import type { Node as PMNode } from "prosemirror-model";

import { createFolioAIEditSnapshot } from "../core/ai-edits/snapshot";
import type {
  FolioAIBlockAnchor,
  FolioAIEditSnapshot,
} from "../core/ai-edits/types";
import { findParagraphByParaId } from "../core/prosemirror/utils/findParagraphByParaId";
import {
  getFolioParaIdFromBlockId,
  getSequentialFolioBlockIdIndex,
} from "../core/types/block-id";

export type DocPositionRange = { from: number; to: number };

type ResolveFolioAIBlockRangeOptions = {
  blockId: string;
  doc: PMNode;
  snapshot?: FolioAIEditSnapshot | null | undefined;
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
  const anchor =
    resolvedSnapshot.anchors[blockId] ??
    resolveSequentialBlockAnchor(blockId, resolvedSnapshot);
  if (!anchor) {
    return null;
  }
  return clampRangeToDocSize(doc.content.size, anchor);
};

/**
 * Resolve a `seq-NNNN` fallback id by document position.
 *
 * A sequential id is only minted for a paragraph the source DOCX left
 * without a `w14:paraId`. The live editor's `ParaIdAllocator` fills
 * that gap with a fresh random hex paraId, so a snapshot of the live
 * document keys the block by that hex and never reproduces the
 * server's `seq-NNNN`: the direct anchor lookup misses, and a
 * paraId-based live lookup can't match either (no node carries a
 * `seq-` paraId). The seq number is the block's 1-based position in
 * the same non-empty-block walk the server extractor and
 * `createFolioAIEditSnapshot` share, so it indexes the snapshot's
 * ordered `blocks` directly.
 */
const resolveSequentialBlockAnchor = (
  blockId: string,
  snapshot: FolioAIEditSnapshot,
): FolioAIBlockAnchor | undefined => {
  const index = getSequentialFolioBlockIdIndex(blockId);
  if (index === null) {
    return undefined;
  }
  const block = snapshot.blocks.at(index - 1);
  return block ? snapshot.anchors[block.id] : undefined;
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
