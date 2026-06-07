/**
 * Shared PM text-scanning helpers.
 *
 * ProseMirror splits text across nodes at every formatting
 * boundary (a bold-only prefix becomes its own text node), so a
 * regex run per text node misses any pattern that straddles a
 * boundary. These helpers join each block's text into one string
 * and map string offsets back to PM doc positions, so callers can
 * scan block-joined text and recover precise PM ranges.
 *
 * Used by the doc-scan plugins (anonymization terms, template
 * directives) that paint overlays on the visible paged canvas.
 */

import type { Node as PMNode } from "prosemirror-model";

export type TextChunk = {
  text: string;
  /** PM doc position where this chunk's first char lives. */
  start: number;
};

/**
 * Collect every block-level node's text content as an array of
 * chunks (one per PM text node), grouped per block. Join a block's
 * chunk texts to scan it as a single string.
 */
export const collectBlockChunks = (doc: PMNode): TextChunk[][] => {
  const blocks: TextChunk[][] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const chunks: TextChunk[] = [];
      node.descendants((child, offset) => {
        if (child.isText && child.text !== undefined) {
          // pos is the textblock's PM position; +1 accounts for the
          // textblock's opening token, +offset is the position of
          // this text node inside the textblock.
          chunks.push({ text: child.text, start: pos + 1 + offset });
        }
        return true;
      });
      if (chunks.length > 0) {
        blocks.push(chunks);
      }
      return false;
    }
    return true;
  });
  return blocks;
};

/** Map a joined-string offset back to its PM doc position. */
export const offsetToDocPos = (chunks: TextChunk[], offset: number): number => {
  let consumed = 0;
  for (const chunk of chunks) {
    if (offset <= consumed + chunk.text.length) {
      return chunk.start + (offset - consumed);
    }
    consumed += chunk.text.length;
  }
  // Past the end: clamp to the final chunk's last position.
  const last = chunks.at(-1);
  return last ? last.start + last.text.length : 0;
};

/** Join a block's chunks into the single string callers scan. */
export const joinChunks = (chunks: TextChunk[]): string =>
  chunks.map((c) => c.text).join("");
