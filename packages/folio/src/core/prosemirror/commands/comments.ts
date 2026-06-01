/**
 * Comment and Track Changes Commands
 *
 * PM commands for adding/removing comments and accepting/rejecting tracked changes.
 */

import type { Mark, Node as PMNode } from "prosemirror-model";
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
      const pPrMarkOps: PPrMarkOp[] = [];

      state.doc.nodesBetween(from, to, (node, pos): boolean => {
        if (node.type.name === "paragraph") {
          const op = collectPPrMarkOp(node, pos, from, to, mode, revisionSet);
          if (op) {
            pPrMarkOps.push(op);
          }

          // Process paragraph property changes (w:pPrChange)
          const propertyChanges = node.attrs["_propertyChanges"] as
            | {
                info?: { id: number; author: string; date: string };
                previousFormatting?: Record<string, unknown>;
              }[]
            | undefined;

          if (
            Array.isArray(propertyChanges) &&
            propertyChanges.length > 0 &&
            rangeCoversParagraphBoundary(from, to, pos, node)
          ) {
            const matches = propertyChanges.filter(
              (c) =>
                revisionSet === null || (c.info && revisionSet.has(c.info.id)),
            );
            if (matches.length > 0) {
              const remaining = propertyChanges.filter(
                (c) =>
                  revisionSet !== null &&
                  (!c.info || !revisionSet.has(c.info.id)),
              );
              const nextAttrs: Record<string, unknown> = {
                ...node.attrs,
                _propertyChanges: remaining.length > 0 ? remaining : null,
              };
              if (mode === "reject") {
                for (const change of matches.toReversed()) {
                  if (change.previousFormatting) {
                    for (const [key, val] of Object.entries(
                      change.previousFormatting,
                    )) {
                      nextAttrs[key] = val;
                    }
                  }
                }
              }
              tr.setNodeMarkup(pos, undefined, nextAttrs);
            }
          }

          return true;
        }
        // Text AND inline atoms (image, shape, hardBreak, tab) can carry
        // tracked-change marks; widen the visitor so rejecting an inserted
        // picture removes it like inserted text. eigenpal #641.
        if (!node.isInline) {
          return true;
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
        return true;
      });

      for (const range of deleteRanges.toReversed()) {
        tr.delete(range.from, range.to);
      }

      // Process paragraph-mark ops from end → start so earlier positions stay
      // valid as later paragraphs collapse. Map every position through the
      // accumulated transaction so the inline deletes above don't desync the
      // attr writes or joins below.
      pPrMarkOps.sort((a, b) => b.paragraphPos - a.paragraphPos);
      for (const op of pPrMarkOps) {
        const mappedPos = tr.mapping.map(op.paragraphPos);
        const paragraph = tr.doc.nodeAt(mappedPos);
        if (!paragraph || paragraph.type.name !== "paragraph") {
          continue;
        }
        if (op.action === "clear") {
          tr.setNodeAttribute(mappedPos, "pPrMark", null);
          continue;
        }
        const joinPos = mappedPos + paragraph.nodeSize;
        if (joinPos >= tr.doc.content.size) {
          // No next sibling to join with (paragraph terminates the doc).
          // Leave the marker in place — Word treats this the same way.
          continue;
        }
        try {
          tr.join(joinPos);
          // PM's `join` keeps the first paragraph's attrs, so the marker
          // would survive an otherwise-resolved revision. Drop it now.
          tr.setNodeAttribute(mappedPos, "pPrMark", null);
        } catch {
          // PM rejects the join if the two blocks aren't structurally
          // compatible (e.g. paragraph followed by a table). Leaving the
          // marker is the safe fallback.
        }
      }

      if (tr.steps.length > 0) {
        dispatch(tr);
      }
    }
    return true;
  };
}

type PPrMarkOp = {
  paragraphPos: number;
  action: "clear" | "join";
};

export type ParagraphBoundaryChange = {
  from: number;
  to: number;
  type: "insertion" | "deletion";
  author?: string;
  date?: string;
  revisionId?: number;
};

type RevisionInfoAttrs = {
  id?: unknown;
  author?: unknown;
  date?: unknown;
};

type ParagraphPropertyChangeAttrs = {
  info?: RevisionInfoAttrs;
  previousFormatting?: Record<string, unknown> | null;
};

function collectPPrMarkOp(
  node: { attrs: Record<string, unknown>; nodeSize: number },
  pos: number,
  from: number,
  to: number,
  mode: "accept" | "reject",
  revisionSet: Set<number> | null,
): PPrMarkOp | null {
  if (!rangeCoversParagraphBoundary(from, to, pos, node)) {
    return null;
  }
  const pPrMark = node.attrs["pPrMark"];
  if (!isPPrMarkAttr(pPrMark)) {
    return null;
  }
  if (revisionSet !== null && !revisionSet.has(pPrMark.info.id)) {
    return null;
  }
  // accept-ins / reject-del keep the paragraph break (clear attr).
  // reject-ins / accept-del remove the paragraph break (join with next).
  const action: PPrMarkOp["action"] =
    (pPrMark.kind === "ins") === (mode === "accept") ? "clear" : "join";
  return { paragraphPos: pos, action };
}

function rangeCoversParagraphBoundary(
  from: number,
  to: number,
  pos: number,
  node: { nodeSize: number },
): boolean {
  const boundaryFrom = pos + node.nodeSize - 1;
  const boundaryTo = pos + node.nodeSize;
  return from <= boundaryFrom && to >= boundaryTo;
}

function isPPrMarkAttr(
  value: unknown,
): value is { kind: "ins" | "del"; info: { id: number } } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  const info = (value as { info?: unknown }).info;
  if (kind !== "ins" && kind !== "del") {
    return false;
  }
  if (typeof info !== "object" || info === null) {
    return false;
  }
  return typeof (info as { id?: unknown }).id === "number";
}

function readRevisionInfo(info: RevisionInfoAttrs | undefined): {
  author?: string;
  date?: string;
  revisionId?: number;
} {
  const revision: { author?: string; date?: string; revisionId?: number } = {};
  if (typeof info?.author === "string") {
    revision.author = info.author;
  }
  if (typeof info?.date === "string") {
    revision.date = info.date;
  }
  if (typeof info?.id === "number") {
    revision.revisionId = info.id;
  }
  return revision;
}

function getListPropertyChangeType(
  attrs: Record<string, unknown>,
  change: ParagraphPropertyChangeAttrs,
): ParagraphBoundaryChange["type"] | null {
  const previousFormatting = change.previousFormatting;
  if (
    previousFormatting == null ||
    !Object.hasOwn(previousFormatting, "numPr")
  ) {
    return null;
  }

  const currentNumPr = attrs["numPr"];
  const previousNumPr = previousFormatting["numPr"];
  if (previousNumPr == null && currentNumPr != null) {
    return "insertion";
  }
  if (previousNumPr != null && currentNumPr == null) {
    return "deletion";
  }
  if (!areNumPrValuesEqual(previousNumPr, currentNumPr)) {
    return currentNumPr == null ? "deletion" : "insertion";
  }
  return null;
}

function areNumPrValuesEqual(left: unknown, right: unknown): boolean {
  if (left == null || right == null) {
    return left == right;
  }
  if (!isObjectRecord(left) || !isObjectRecord(right)) {
    return Object.is(left, right);
  }
  return left["numId"] === right["numId"] && left["ilvl"] === right["ilvl"];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toParagraphBoundaryChange(
  node: PMNode,
  pos: number,
  type: ParagraphBoundaryChange["type"],
  info?: RevisionInfoAttrs,
): ParagraphBoundaryChange {
  return {
    from: pos + node.nodeSize - 1,
    to: pos + node.nodeSize,
    type,
    ...readRevisionInfo(info),
  };
}

export function findParagraphBoundaryChangeAtPosition(
  state: EditorState,
  pos: number,
): ParagraphBoundaryChange | null {
  const $pos = state.doc.resolve(pos);
  const node = $pos.parent;
  if (node.type.name !== "paragraph") {
    return null;
  }

  const paragraphPos = $pos.before($pos.depth);
  const pPrMark = node.attrs["pPrMark"];
  if (isPPrMarkAttr(pPrMark)) {
    return toParagraphBoundaryChange(
      node,
      paragraphPos,
      pPrMark.kind === "ins" ? "insertion" : "deletion",
      pPrMark.info,
    );
  }

  const propertyChanges = node.attrs["_propertyChanges"] as
    | ParagraphPropertyChangeAttrs[]
    | undefined;
  if (!Array.isArray(propertyChanges)) {
    return null;
  }

  for (const change of propertyChanges) {
    const type = getListPropertyChangeType(node.attrs, change);
    if (type) {
      return toParagraphBoundaryChange(node, paragraphPos, type, change.info);
    }
  }

  return null;
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
    // Widen from `isText` to `isInline` so an AI-edit revision on an inline
    // atom (image, shape) shows up in the matched range. eigenpal #641.
    if (!node.isInline) {
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

  // Find the text node at this position and its mark instance. We capture
  // the specific instance (not just the type) so the adjacency expansion
  // below stays inside a single revision — two back-to-back insertions
  // belonging to different `revisionId`s must not be treated as one range.
  let markStart = from;
  let markEnd = from;
  let foundMark: Mark | undefined;

  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    const childStart = $pos.start() + offset;
    const childEnd = childStart + child.nodeSize;
    if (from >= childStart && from <= childEnd && child.isText) {
      for (const mark of child.marks) {
        if (mark.type === insertionType || mark.type === deletionType) {
          foundMark = mark;
          markStart = childStart;
          markEnd = childEnd;
        }
      }
    }
  });

  if (foundMark === undefined) {
    const paragraphChange = findParagraphBoundaryChangeAtPosition(state, from);
    return paragraphChange
      ? { from: paragraphChange.from, to: paragraphChange.to }
      : { from, to };
  }

  // Expand to adjacent nodes carrying the *same* mark instance (matching
  // attrs, including revisionId). Two passes — one left-to-right and one
  // right-to-left — so the expansion can cross more than one neighbouring
  // text node on either side (forEach doesn't revisit earlier siblings,
  // which a single-pass walk would need to do to extend leftward by more
  // than one step).
  const sameMark = foundMark;
  const children: {
    childStart: number;
    childEnd: number;
    marks: readonly Mark[];
  }[] = [];
  // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
  node.forEach((child, offset) => {
    if (!child.isText) {
      return;
    }
    const childStart = $pos.start() + offset;
    children.push({
      childStart,
      childEnd: childStart + child.nodeSize,
      marks: child.marks,
    });
  });
  let extended = true;
  while (extended) {
    extended = false;
    for (const child of children) {
      if (!child.marks.some((m) => m.eq(sameMark))) {
        continue;
      }
      if (child.childEnd === markStart) {
        markStart = child.childStart;
        extended = true;
      }
      if (child.childStart === markEnd) {
        markEnd = child.childEnd;
        extended = true;
      }
    }
  }

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
  mark: Mark,
  fromHint: number,
  toHint: number,
): { from: number; to: number } {
  const carriesSameInlineMark = (node: PMNode | null): node is PMNode =>
    node?.isInline === true && node.marks.some((m) => m.eq(mark));

  // Resolve the boundary positions and hop outward through `nodeBefore`
  // / `nodeAfter` while the neighbouring inline node still carries the
  // same mark instance. O(K) in the number of text nodes that make up
  // the span — `nodesBetween`-based fixed-point expansion is O(K²) and
  // re-walks the same subtree on every iteration.
  let from = fromHint;
  let to = toHint;
  let $from = state.doc.resolve(from);
  let nodeBefore = $from.nodeBefore;
  while (carriesSameInlineMark(nodeBefore)) {
    from -= nodeBefore.nodeSize;
    $from = state.doc.resolve(from);
    nodeBefore = $from.nodeBefore;
  }
  let $to = state.doc.resolve(to);
  let nodeAfter = $to.nodeAfter;
  while (carriesSameInlineMark(nodeAfter)) {
    to += nodeAfter.nodeSize;
    $to = state.doc.resolve(to);
    nodeAfter = $to.nodeAfter;
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
    // Widen from `isText` to `isInline` so an image-only insertion / deletion
    // appears in the find-next walk (an atomic image carries the mark itself,
    // not as a text-node sibling). eigenpal #641.
    if (!node.isInline) {
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
  // Remember the specific mark instance that produced the kept result, so
  // the walk can skip later text nodes covered by the same expansion
  // without skipping a sibling that carries a *different* tracked-change
  // mark (e.g., an `insertion + deletion` overlay where the same text
  // node belongs to two distinct revisions). Skipping by position alone
  // would miss the nearer overlapping change.
  let resultMark: Mark | null = null;

  state.doc.descendants((node, pos) => {
    // Widen from `isText` to `isInline` so an image-only change appears in
    // the find-previous walk. eigenpal #641.
    if (!node.isInline) {
      return;
    }
    if (pos >= startPos) {
      return false;
    }
    if (
      result.value &&
      resultMark &&
      pos < result.value.to &&
      node.marks.every(
        (m) =>
          (m.type !== insertionType && m.type !== deletionType) ||
          m.eq(resultMark!),
      )
    ) {
      // Already covered by the previous expansion AND no additional
      // tracked-change mark sits on this node — safe to skip.
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
        resultMark = mark;
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
