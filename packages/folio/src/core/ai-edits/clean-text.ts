import type { Node as PMNode } from "prosemirror-model";

/**
 * "Post-tracked-changes" view of a textblock: the string the user
 * would see if every existing tracked change were accepted.
 * `deletion`-marked text is skipped, `insertion`-marked text is
 * included as plain text, everything else is included as-is.
 *
 * `offsets[i]` is the absolute ProseMirror position to use when you
 * want to anchor at the character at clean-offset `i`. `offsets`
 * has length `text.length + 1` so callers can ask for the position
 * immediately after the last character, which is the right anchor
 * for an insertion at end-of-block.
 *
 * This is the view the AI should reason against (so it doesn't see
 * `"shallmust"` smashed together) and the view the apply engine's
 * find-string lookup should run against (so the same offsets it
 * sent us still resolve to the right PM positions on a doc with
 * pending tracked changes).
 */
export type CleanBlockText = {
  text: string;
  offsets: number[];
};

const DELETION_MARK = "deletion";

export const buildCleanBlockText = (
  blockNode: PMNode,
  blockFrom: number,
): CleanBlockText => {
  let text = "";
  const offsets: number[] = [];
  let lastEnd = blockFrom + 1;
  blockNode.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) {
      return true;
    }
    if (node.marks.some((mark) => mark.type.name === DELETION_MARK)) {
      // Skip the run entirely. Don't update lastEnd — if the next
      // surviving char sits right after the deletion in the live
      // doc, we still want offsets to anchor at the live position
      // (which sits past the skipped run).
      return false;
    }
    const startPos = blockFrom + 1 + pos;
    for (let i = 0; i < node.text.length; i++) {
      offsets.push(startPos + i);
    }
    text += node.text;
    lastEnd = startPos + node.text.length;
    return true;
  });
  offsets.push(lastEnd);
  return { text, offsets };
};
