/**
 * Positional text helpers.
 *
 * ProseMirror positions are not the same as string offsets — each block
 * node adds two positions (its open + close tokens) that are absent
 * from a flattened text representation. The helpers in this module
 * walk a PM document, returning the plain text alongside an index
 * lookup that maps each text character back to its PM position.
 *
 * Used by the AI suggestion conflict resolver (to anchor suggestions
 * back into the live document) and by the mock generator (to map
 * regex hits back to PM ranges).
 */

import type { Node as PMNode } from "prosemirror-model";

const BLOCK_SEPARATOR = "\n";

export type PositionalText = {
  /** Concatenated text content, with `\n` between block nodes. */
  text: string;
  /**
   * For each character at index `i` in `text`, returns the PM position
   * of that character (i.e., the position just before it). Block
   * separator characters map to the position immediately after the
   * preceding block.
   */
  pmPositionAt: (textIndex: number) => number;
};

/**
 * Walk a slice of the document, returning its text plus a position
 * lookup. The walk skips past block boundaries, inserting a
 * separator character so consumers can identify line breaks.
 */
export function buildPositionalText(
  doc: PMNode,
  from = 0,
  to: number = doc.content.size,
): PositionalText {
  const chunks: string[] = [];
  const offsets: number[] = [];

  let textLength = 0;
  let lastBlockEnd: number | null = null;

  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      const text = node.text ?? "";
      const startInNode = Math.max(from, pos);
      const endInNode = Math.min(to, pos + node.nodeSize);
      if (endInNode <= startInNode) {
        return false;
      }
      const sliceStart = startInNode - pos;
      const sliceEnd = endInNode - pos;
      const slice = text.slice(sliceStart, sliceEnd);
      if (slice.length === 0) {
        return false;
      }
      chunks.push(slice);
      for (let i = 0; i < slice.length; i++) {
        offsets.push(startInNode + i);
      }
      textLength += slice.length;
      return false;
    }

    if (node.isBlock) {
      if (lastBlockEnd !== null && textLength > 0) {
        chunks.push(BLOCK_SEPARATOR);
        offsets.push(lastBlockEnd);
        textLength += BLOCK_SEPARATOR.length;
      }
      lastBlockEnd = pos + node.nodeSize - 1;
    }
    return true;
  });

  const text = chunks.join("");
  return {
    text,
    pmPositionAt: (textIndex: number): number => {
      if (textIndex < 0) {
        return offsets[0] ?? from;
      }
      if (textIndex >= offsets.length) {
        return (offsets.at(-1) ?? from) + 1;
      }
      const value = offsets[textIndex];
      return value ?? from;
    },
  };
}
