/**
 * Lifted from
 * https://github.com/eigenpal/docx-editor/blob/main/packages/core/src/prosemirror/utils/findParagraphByParaId.ts
 * (Apache-2.0). Keep in sync upstream.
 */

import type { Node as PMNode } from "prosemirror-model";

/**
 * ProseMirror position range for the paragraph (or any textblock) whose
 * `paraId` attribute equals `paraId`. Returns the inclusive `from` and
 * exclusive `to` positions, plus the node, so callers can both target
 * the paragraph (e.g. addMark over its text range) and inspect it.
 *
 * `from` is the position immediately before the textblock; `to` is
 * `from + node.nodeSize`. The text content lives at `[from + 1, to - 1]`.
 *
 * Returns null if no textblock with that paraId exists.
 */
export const findParagraphByParaId = (
  doc: PMNode,
  paraId: string,
): { node: PMNode; from: number; to: number } | null => {
  if (!paraId || !paraId.trim()) {
    return null;
  }
  let result: { node: PMNode; from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (result !== null) {
      return false;
    }
    const nodeParaId = node.attrs["paraId"];
    if (node.isTextblock && nodeParaId === paraId) {
      result = { node, from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return result;
};

/**
 * Sugar over {@link findParagraphByParaId} when callers only need the
 * `from` position (e.g. to feed `scrollToPosition`).
 */
export const findStartPosForParaId = (
  doc: PMNode,
  paraId: string,
): number | null => findParagraphByParaId(doc, paraId)?.from ?? null;
