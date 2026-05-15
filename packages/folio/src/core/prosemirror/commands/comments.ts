/**
 * Comment and Track Changes Commands
 *
 * PM commands for adding/removing comments and accepting/rejecting tracked changes.
 */

import type { Command, EditorState } from "prosemirror-state";

/**
 * Add a comment mark to the current selection.
 */
export function addCommentMark(commentId: number): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) {
      return false;
    }

    const commentType = state.schema.marks["comment"];
    if (!commentType) {
      return false;
    }

    if (dispatch) {
      const tr = state.tr.addMark(from, to, commentType.create({ commentId }));
      dispatch(tr);
    }
    return true;
  };
}

/**
 * Remove a comment mark by ID from the entire document.
 */
export function removeCommentMark(commentId: number): Command {
  return (state, dispatch) => {
    const commentType = state.schema.marks["comment"];
    if (!commentType) {
      return false;
    }

    if (dispatch) {
      const tr = state.tr;
      state.doc.descendants((node, pos) => {
        if (node.isText) {
          for (const mark of node.marks) {
            if (
              mark.type === commentType &&
              mark.attrs["commentId"] === commentId
            ) {
              tr.removeMark(pos, pos + node.nodeSize, mark);
            }
          }
        }
      });
      if (tr.steps.length > 0) {
        dispatch(tr);
      }
    }
    return true;
  };
}

/**
 * Resolve a tracked change: accept or reject.
 * - Accept: keep insertions (remove mark), delete deletions (remove text)
 * - Reject: keep deletions (remove mark), delete insertions (remove text)
 *
 * Pass `revisionId` to scope the operation to one specific
 * revision — otherwise overlapping marks for other revisions get
 * processed too, silently consuming pending work. Without an id
 * the operation matches every insertion/deletion mark in the
 * range (the bulk accept-all/reject-all path).
 */
function resolveChange(
  from: number,
  to: number,
  mode: "accept" | "reject",
  revisionIds?: readonly number[],
): Command {
  return (state, dispatch) => {
    const insertionType = state.schema.marks["insertion"];
    const deletionType = state.schema.marks["deletion"];
    if (!insertionType && !deletionType) {
      return false;
    }

    const keepType = mode === "accept" ? insertionType : deletionType;
    const removeType = mode === "accept" ? deletionType : insertionType;
    const revisionSet =
      revisionIds === undefined ? null : new Set<number>(revisionIds);
    const matchesRevision = (mark: { attrs: Record<string, unknown> }) =>
      revisionSet === null ||
      (typeof mark.attrs["revisionId"] === "number" &&
        revisionSet.has(mark.attrs["revisionId"]));

    if (dispatch) {
      const tr = state.tr;
      const deleteRanges: { from: number; to: number }[] = [];

      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) {
          return;
        }
        const nodeEnd = pos + node.nodeSize;
        const rangeFrom = Math.max(from, pos);
        const rangeTo = Math.min(to, nodeEnd);

        if (
          removeType &&
          node.marks.some((m) => m.type === removeType && matchesRevision(m))
        ) {
          deleteRanges.push({ from: rangeFrom, to: rangeTo });
        }

        for (const mark of node.marks) {
          if (keepType && mark.type === keepType && matchesRevision(mark)) {
            tr.removeMark(rangeFrom, rangeTo, mark);
          }
        }
      });

      for (const range of deleteRanges.toReversed()) {
        tr.delete(range.from, range.to);
      }

      if (tr.steps.length > 0) {
        dispatch(tr);
      }
    }
    return true;
  };
}

/**
 * Accept a tracked change at the given range.
 * - Insertion: remove mark, keep text
 * - Deletion: remove mark AND text
 */
export function acceptChange(from: number, to: number): Command {
  return resolveChange(from, to, "accept");
}

/**
 * Reject a tracked change at the given range.
 * - Insertion: remove mark AND text
 * - Deletion: remove mark, keep text
 */
export function rejectChange(from: number, to: number): Command {
  return resolveChange(from, to, "reject");
}

/**
 * Accept all tracked changes in the document.
 */
export function acceptAllChanges(): Command {
  return (state, dispatch) =>
    acceptChange(0, state.doc.content.size)(state, dispatch);
}

/**
 * Reject all tracked changes in the document.
 */
export function rejectAllChanges(): Command {
  return (state, dispatch) =>
    rejectChange(0, state.doc.content.size)(state, dispatch);
}

/**
 * Find the document range covered by all insertion/deletion marks
 * carrying any of the given AI-edit `revisionIds`. Returns null when
 * none of those marks are present (already accepted/rejected, or
 * never existed). A replace operation typically passes two ids (one
 * for its deletion side, one for its insertion side); inserts and
 * standalone deletions pass a single id.
 */
export function findAIEditRevisionRange(
  state: EditorState,
  revisionIds: number | readonly number[],
): { from: number; to: number } | null {
  const insertionType = state.schema.marks["insertion"];
  const deletionType = state.schema.marks["deletion"];
  if (!insertionType && !deletionType) {
    return null;
  }
  const idSet = new Set<number>(
    typeof revisionIds === "number" ? [revisionIds] : revisionIds,
  );

  const range = { from: null as number | null, to: null as number | null };

  state.doc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }
    for (const mark of node.marks) {
      if (
        (mark.type === insertionType || mark.type === deletionType) &&
        typeof mark.attrs["revisionId"] === "number" &&
        idSet.has(mark.attrs["revisionId"])
      ) {
        const start = pos;
        const end = pos + node.nodeSize;
        if (range.from === null || start < range.from) {
          range.from = start;
        }
        if (range.to === null || end > range.to) {
          range.to = end;
        }
        break;
      }
    }
    return undefined;
  });

  if (range.from === null || range.to === null) {
    return null;
  }
  return { from: range.from, to: range.to };
}

/**
 * Accept the tracked-change marks belonging to an AI-edit operation.
 * Pass a single revisionId for inserts/standalone deletions, or the
 * full id list for a replace (one id per side). Returns false when
 * none of the ids match anything in the doc.
 */
export function acceptAIEditRevision(
  revisionIds: number | readonly number[],
): Command {
  return (state, dispatch) => {
    const range = findAIEditRevisionRange(state, revisionIds);
    if (!range) {
      return false;
    }
    const ids = typeof revisionIds === "number" ? [revisionIds] : revisionIds;
    return resolveChange(range.from, range.to, "accept", ids)(state, dispatch);
  };
}

/**
 * Reject the tracked-change marks belonging to an AI-edit operation.
 * See {@link acceptAIEditRevision} for the id semantics.
 */
export function rejectAIEditRevision(
  revisionIds: number | readonly number[],
): Command {
  return (state, dispatch) => {
    const range = findAIEditRevisionRange(state, revisionIds);
    if (!range) {
      return false;
    }
    const ids = typeof revisionIds === "number" ? [revisionIds] : revisionIds;
    return resolveChange(range.from, range.to, "reject", ids)(state, dispatch);
  };
}

type ChangeRange = {
  from: number;
  to: number;
  type: "insertion" | "deletion";
};

/**
 * Find the tracked change mark range at a given cursor position.
 * If the cursor is inside a tracked change, returns the full extent
 * of that mark (expanding to cover all adjacent nodes with the same
 * revision ID). If from !== to (range selection), returns {from, to}.
 */
export function findChangeAtPosition(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  // If there's a range selection, use it directly
  if (from !== to) {
    return { from, to };
  }

  const insertionType = state.schema.marks["insertion"];
  const deletionType = state.schema.marks["deletion"];
  if (!insertionType && !deletionType) {
    return { from, to };
  }

  // Resolve the position and check marks at cursor
  const $pos = state.doc.resolve(from);
  const node = $pos.parent;
  if (!node.isTextblock) {
    return { from, to };
  }

  // Find the text node at this position and its mark
  let markStart = from;
  let markEnd = from;
  let foundMark: typeof insertionType | undefined;

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    const childStart = $pos.start() + offset;
    const childEnd = childStart + child.nodeSize;
    if (from >= childStart && from <= childEnd && child.isText) {
      for (const mark of child.marks) {
        if (mark.type === insertionType || mark.type === deletionType) {
          foundMark = mark.type;
          markStart = childStart;
          markEnd = childEnd;
        }
      }
    }
  });

  if (foundMark === undefined) {
    return { from, to };
  }

  // Expand to adjacent nodes with the same mark type
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    const childStart = $pos.start() + offset;
    const childEnd = childStart + child.nodeSize;
    if (child.isText && child.marks.some((m) => m.type === foundMark)) {
      if (childEnd === markStart) {
        markStart = childStart;
      }
      if (childStart === markEnd) {
        markEnd = childEnd;
      }
    }
  });

  return { from: markStart, to: markEnd };
}

/**
 * Walk outward from `[fromHint, toHint]` and return the full extent of the
 * tracked-change span carrying `mark` (matched via `Mark.eq`, so attrs like
 * `revisionId` distinguish adjacent changes). Used to keep the
 * navigation/scroll helpers honest when a tracked-change span is split
 * across multiple text nodes due to inline formatting (e.g., a bold word
 * inside an insertion).
 */
function expandTrackedChangeRange(
  state: EditorState,
  mark: import("prosemirror-model").Mark,
  fromHint: number,
  toHint: number,
): { from: number; to: number } {
  // Resolve the boundary positions and hop outward through `nodeBefore`
  // / `nodeAfter` while the neighbouring text node still carries the
  // same mark instance. O(K) in the number of text nodes that make up
  // the span — `nodesBetween`-based fixed-point expansion is O(K²) and
  // re-walks the same subtree on every iteration.
  let from = fromHint;
  let to = toHint;
  let $from = state.doc.resolve(from);
  while (
    $from.nodeBefore?.isText &&
    $from.nodeBefore.marks.some((m) => m.eq(mark))
  ) {
    from -= $from.nodeBefore.nodeSize;
    $from = state.doc.resolve(from);
  }
  let $to = state.doc.resolve(to);
  while ($to.nodeAfter?.isText && $to.nodeAfter.marks.some((m) => m.eq(mark))) {
    to += $to.nodeAfter.nodeSize;
    $to = state.doc.resolve(to);
  }
  return { from, to };
}

/**
 * Find the next tracked change after the given position. Returns the full
 * range of the change (including adjacent text nodes that share the same
 * insertion/deletion mark instance), not just the first text node.
 */
export function findNextChange(
  state: EditorState,
  startPos: number,
): ChangeRange | null {
  const insertionType = state.schema.marks["insertion"];
  const deletionType = state.schema.marks["deletion"];
  if (!insertionType && !deletionType) {
    return null;
  }

  const result = { value: null as ChangeRange | null };

  state.doc.descendants((node, pos) => {
    if (result.value) {
      return false;
    }
    if (!node.isText) {
      return;
    }
    if (pos + node.nodeSize <= startPos) {
      return;
    }

    for (const mark of node.marks) {
      if (mark.type === insertionType || mark.type === deletionType) {
        // Return the FULL expanded range, even when `startPos` lands
        // inside the matched span. A toolbar that does
        // `findNextChange(state, selectionEnd)` and then accepts the
        // returned range must see the whole revision — clamping `from`
        // up to `startPos` truncates the earlier portion of the same
        // change and leaves orphaned marks behind after accept.
        const expanded = expandTrackedChangeRange(
          state,
          mark,
          pos,
          pos + node.nodeSize,
        );
        result.value = {
          from: expanded.from,
          to: expanded.to,
          type: mark.type === insertionType ? "insertion" : "deletion",
        };
        return false;
      }
    }
    return undefined;
  });

  // Wrap around (only once)
  if (result.value === null && startPos > 0) {
    return findNextChange(state, 0);
  }

  return result.value;
}

/**
 * Find the previous tracked change before the given position. Returns the
 * full range of the change (including adjacent text nodes that share the
 * same insertion/deletion mark instance), not just the last text node.
 */
export function findPreviousChange(
  state: EditorState,
  startPos: number,
): ChangeRange | null {
  const insertionType = state.schema.marks["insertion"];
  const deletionType = state.schema.marks["deletion"];
  if (!insertionType && !deletionType) {
    return null;
  }

  const result = { value: null as ChangeRange | null };

  state.doc.descendants((node, pos) => {
    if (!node.isText) {
      return;
    }
    if (pos >= startPos) {
      return false;
    }
    // The forward walk would otherwise re-expand the same span once per
    // text node inside it. Skip nodes already covered by the most
    // recent kept result — the previous expansion already included
    // them, and expansion is idempotent.
    if (result.value && pos < result.value.to) {
      return;
    }

    for (const mark of node.marks) {
      if (mark.type === insertionType || mark.type === deletionType) {
        const expanded = expandTrackedChangeRange(
          state,
          mark,
          pos,
          pos + node.nodeSize,
        );
        result.value = {
          from: expanded.from,
          to: expanded.to,
          type: mark.type === insertionType ? "insertion" : "deletion",
        };
      }
    }
    return undefined;
  });

  // Wrap around (only once — guard prevents infinite recursion)
  if (result.value === null && startPos < state.doc.content.size) {
    return findPreviousChange(state, state.doc.content.size);
  }

  return result.value;
}
