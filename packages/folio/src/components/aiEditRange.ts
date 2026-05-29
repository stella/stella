/**
 * Helpers shared by the AI-edit imperative API methods.
 *
 * Lives outside `DocxEditor.tsx` so the bounds-checking logic that protects
 * `TextSelection.between` from "endpoint not pointing into a node with
 * inline content" can be unit-tested without spinning up a real PM view.
 */

import type { Node as PMNode } from "prosemirror-model";

import {
  createFolioAIEditSnapshot,
  getFolioAIParaIdFromBlockId,
} from "../core/ai-edits/snapshot";
import type { FolioAIEditSnapshot } from "../core/ai-edits/types";
import { findParagraphByParaId } from "../core/prosemirror/utils/findParagraphByParaId";
import type { FolioBlockId } from "../core/types/block-id";

export type DocPositionRange = { from: number; to: number };

type ResolveFolioAIBlockRangeOptions = {
  blockId: FolioBlockId;
  doc: PMNode;
  snapshot?: FolioAIEditSnapshot | null | undefined;
};

export const resolveFolioAIBlockRange = ({
  blockId,
  doc,
  snapshot,
}: ResolveFolioAIBlockRangeOptions): DocPositionRange | null => {
  const paraId = getFolioAIParaIdFromBlockId(blockId);
  if (paraId !== null) {
    const liveRange = findParagraphByParaId(doc, paraId);
    if (liveRange !== null) {
      return { from: liveRange.from, to: liveRange.to };
    }
  }

  const resolvedSnapshot = snapshot ?? createFolioAIEditSnapshot(doc);
  const anchor = resolvedSnapshot.anchors[blockId];
  if (!anchor) {
    return null;
  }
  return clampRangeToDocSize(doc.content.size, anchor);
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
