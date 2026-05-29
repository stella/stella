/**
 * Suggestion Mode Plugin
 *
 * When active, intercepts all text insertions and deletions,
 * wrapping them in tracked change marks (insertion/deletion)
 * instead of modifying the document directly.
 *
 * - Typed text is marked as insertion (green underline)
 * - Deleted text is NOT removed — it's marked as deletion (red strikethrough)
 * - Text already marked as insertion by the current author is deleted normally
 *   (retracting your own suggestion)
 */

import type { Node as PMNode, MarkType } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import type { TrackedChangeInfo } from "../../types/document";
import { splitBlockClearBorders } from "../extensions/features/BaseKeymapExtension";

export const suggestionModeKey = new PluginKey<SuggestionModeState>(
  "suggestionMode",
);
const SUGGESTION_META = "suggestionModeApplied";

type SuggestionModeState = {
  active: boolean;
  author: string;
};

type MarkAttrs = {
  revisionId: number;
  author: string;
  date: string;
};

let nextRevisionId = Date.now();

function makeMarkAttrs(pluginState: SuggestionModeState): MarkAttrs {
  return {
    revisionId: nextRevisionId++,
    author: pluginState.author,
    date: new Date().toISOString(),
  };
}

function makeParagraphMarkInfo(
  pluginState: SuggestionModeState,
): TrackedChangeInfo {
  const attrs = makeMarkAttrs(pluginState);
  return {
    id: attrs.revisionId,
    author: attrs.author,
    date: attrs.date,
  };
}

/**
 * Find an adjacent mark of the same type by the same author.
 * Reuses its revisionId so consecutive edits group into one change.
 */
function findAdjacentRevision(
  doc: PMNode,
  pos: number,
  markTypeName: string,
  author: string,
): MarkAttrs | null {
  try {
    const $pos = doc.resolve(pos);
    for (const node of [$pos.nodeBefore, $pos.nodeAfter]) {
      if (node?.isText) {
        const mark = node.marks.find(
          (m) => m.type.name === markTypeName && m.attrs["author"] === author,
        );
        if (mark) {
          return mark.attrs as MarkAttrs;
        }
      }
    }
  } catch {
    /* position out of range */
  }
  return null;
}

/**
 * Find an adjacent revision at either edge of a range.
 * This keeps consecutive backspaces grouped even though the cursor moves left.
 */
function findAdjacentRevisionForRange(
  doc: PMNode,
  from: number,
  to: number,
  markTypeName: string,
  author: string,
): MarkAttrs | null {
  return (
    findAdjacentRevision(doc, from, markTypeName, author) ??
    findAdjacentRevision(doc, to, markTypeName, author)
  );
}

/**
 * Walk a text range and either mark as deletion or retract own insertions.
 * Processes in reverse order to maintain position validity.
 */
function markRangeAsDeleted(
  tr: Transaction,
  doc: PMNode,
  from: number,
  to: number,
  insertionType: MarkType,
  deletionType: MarkType,
  pluginState: SuggestionModeState,
): void {
  const ranges: { from: number; to: number; isOwnInsert: boolean }[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) {
      return;
    }
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    if (start >= end) {
      return;
    }
    const isOwnInsert = node.marks.some(
      (m) =>
        m.type === insertionType && m.attrs["author"] === pluginState.author,
    );
    ranges.push({ from: start, to: end, isOwnInsert });
  });

  if (ranges.length === 0) {
    return;
  }

  const delAttrs =
    findAdjacentRevisionForRange(
      doc,
      from,
      to,
      "deletion",
      pluginState.author,
    ) || makeMarkAttrs(pluginState);

  for (let i = ranges.length - 1; i >= 0; i--) {
    // SAFETY: i >= 0 and i < ranges.length in for loop
    const range = ranges[i]!;
    if (range.isOwnInsert) {
      tr.delete(range.from, range.to);
    } else {
      tr.addMark(range.from, range.to, deletionType.create(delAttrs));
    }
  }
}

/**
 * Insert text as a tracked insertion, optionally marking replaced selection as deletion.
 */
function applySuggestionInsert(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  pluginState: SuggestionModeState,
): boolean {
  const insertionType = view.state.schema.marks["insertion"];
  if (!insertionType) {
    return false;
  }

  const tr = view.state.tr;
  tr.setMeta(SUGGESTION_META, true);

  const insertAttrs =
    findAdjacentRevision(
      view.state.doc,
      from,
      "insertion",
      pluginState.author,
    ) || makeMarkAttrs(pluginState);

  if (from !== to) {
    const deletionType = view.state.schema.marks["deletion"];
    if (deletionType) {
      markRangeAsDeleted(
        tr,
        view.state.doc,
        from,
        to,
        insertionType,
        deletionType,
        pluginState,
      );
    }
  }

  const insertAt = tr.mapping.map(to);
  tr.insertText(text, insertAt, insertAt);

  // Strip inherited deletion marks — new text must never be marked as deleted.
  const deletionType = view.state.schema.marks["deletion"];
  if (deletionType) {
    tr.removeMark(insertAt, insertAt + text.length, deletionType);
  }

  // Apply the correct insertion mark. If the cursor was inside an existing
  // insertion by the same author, insertText already inherited that mark and
  // insertAttrs will match — addMark is effectively a no-op that preserves
  // the continuous mark span. We intentionally do NOT removeMark(insertionType)
  // first, because that fragments the mark span and creates a nested change.
  tr.addMark(
    insertAt,
    insertAt + text.length,
    insertionType.create(insertAttrs),
  );

  view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Track-changes Enter: split the paragraph and stamp `pPrMark = 'ins'` on the
 * FIRST half of the split (the upper paragraph), per ECMA-376 §17.13.5. The
 * actual splitting reuses `splitBlockClearBorders` so border/style/stored-mark
 * behavior stays identical to ordinary editing.
 *
 * If the source paragraph already carries a `pPrMark`, leave it alone — a
 * prior author's revision must not be silently overwritten.
 */
function handleSuggestionEnter(
  view: EditorView,
  pluginState: SuggestionModeState,
): boolean {
  const { $from } = view.state.selection;
  if ($from.parent.type.name !== "paragraph") {
    return false;
  }
  const sourcePos = $from.before();
  const sourceAttrs = $from.parent.attrs;

  const captured = { tr: null as Transaction | null };
  const ok = splitBlockClearBorders(
    view.state,
    (tr: Transaction) => {
      captured.tr = tr;
    },
    view,
  );
  if (!ok || !captured.tr) {
    return false;
  }
  const tr = captured.tr;
  if (sourceAttrs["pPrMark"] == null) {
    const sourceParagraph = tr.doc.nodeAt(sourcePos);
    if (sourceParagraph?.type.name === "paragraph") {
      const markInfo: ParagraphMarkAttr = {
        kind: "ins",
        info: makeParagraphMarkInfo(pluginState),
      };
      tr.setNodeAttribute(sourcePos, "pPrMark", markInfo);
    }
  }
  view.dispatch(tr.scrollIntoView());
  return true;
}

type ParagraphMarkAttr = {
  kind: "ins" | "del";
  info: TrackedChangeInfo;
};

/**
 * Detect a caret-at-paragraph-boundary scenario where Backspace/Delete should
 * record a tracked paragraph-mark deletion instead of joining paragraphs.
 *
 * Returns the position of the paragraph whose `pPrMark` should be set, or
 * `null` if the caret is mid-paragraph (let the normal text-delete path run).
 *
 * - Backspace-at-paragraph-start → previous sibling paragraph.
 * - Delete-at-paragraph-end     → current paragraph.
 *
 * Returns `null` when there is no adjacent sibling paragraph (the join would
 * not produce paragraph-mark merging — e.g. doc start, doc end, or sibling
 * is a table). The default merge path then runs unchanged.
 */
export function paragraphBoundaryTarget(
  state: EditorState,
  direction: "backward" | "forward",
): number | null {
  const { $from, empty } = state.selection;
  if (!empty) {
    return null;
  }
  if ($from.parent.type.name !== "paragraph") {
    return null;
  }
  const paragraphStart = $from.before();
  const paragraphEnd = $from.after();

  if (direction === "backward") {
    if ($from.parentOffset !== 0) {
      return null;
    }
    if (paragraphStart === 0) {
      return null;
    }
    const $prevEdge = state.doc.resolve(paragraphStart);
    const prev = $prevEdge.nodeBefore;
    if (!prev || prev.type.name !== "paragraph") {
      return null;
    }
    return paragraphStart - prev.nodeSize;
  }

  if ($from.parentOffset !== $from.parent.content.size) {
    return null;
  }
  if (paragraphEnd >= state.doc.content.size) {
    return null;
  }
  const $nextEdge = state.doc.resolve(paragraphEnd);
  const next = $nextEdge.nodeAfter;
  if (!next || next.type.name !== "paragraph") {
    return null;
  }
  return paragraphStart;
}

/**
 * Mark a paragraph break as a tracked deletion. `target` is the position of
 * the paragraph whose closing mark is being deleted (per OOXML, that's the
 * previous paragraph for Backspace-at-start and the current paragraph for
 * Delete-at-end). If the existing mark is the current author's insertion,
 * retract it by joining the paragraphs back together.
 */
function applyPPrDel(
  view: EditorView,
  targetParagraphPos: number,
  pluginState: SuggestionModeState,
): boolean {
  const targetNode = view.state.doc.nodeAt(targetParagraphPos);
  if (!targetNode || targetNode.type.name !== "paragraph") {
    return false;
  }
  const existingMark = targetNode.attrs["pPrMark"];
  if (isCurrentAuthorParagraphInsertion(existingMark, pluginState.author)) {
    const tr = view.state.tr;
    tr.setMeta(SUGGESTION_META, true);
    const joinPos = targetParagraphPos + targetNode.nodeSize;
    try {
      tr.join(joinPos);
      tr.setNodeAttribute(targetParagraphPos, "pPrMark", null);
      view.dispatch(tr.scrollIntoView());
    } catch {
      return true;
    }
    return true;
  }
  if (existingMark != null) {
    return true;
  }
  const tr = view.state.tr;
  tr.setMeta(SUGGESTION_META, true);
  const markInfo: ParagraphMarkAttr = {
    kind: "del",
    info: makeParagraphMarkInfo(pluginState),
  };
  tr.setNodeAttribute(targetParagraphPos, "pPrMark", markInfo);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function isCurrentAuthorParagraphInsertion(
  value: unknown,
  author: string,
): value is ParagraphMarkAttr {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const mark = value as { kind?: unknown; info?: unknown };
  if (
    mark.kind !== "ins" ||
    typeof mark.info !== "object" ||
    mark.info === null
  ) {
    return false;
  }
  const info = mark.info as { author?: unknown };
  return info.author === author;
}

/**
 * Handle delete (forward or backward) in suggestion mode.
 */
function handleSuggestionDelete(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  direction: "backward" | "forward",
): boolean {
  const pluginState = suggestionModeKey.getState(state);
  if (!pluginState?.active) {
    return false;
  }

  const { $from, $to, empty } = state.selection;
  const insertionType = state.schema.marks["insertion"];
  const deletionType = state.schema.marks["deletion"];
  if (!insertionType || !deletionType) {
    return false;
  }

  if (!dispatch) {
    return true;
  }

  const tr = state.tr;
  tr.setMeta(SUGGESTION_META, true);

  // --- Selection delete ---
  if (!empty) {
    markRangeAsDeleted(
      tr,
      state.doc,
      $from.pos,
      $to.pos,
      insertionType,
      deletionType,
      pluginState,
    );
    // Collapse cursor to after the marked/retracted content
    const cursorPos = tr.mapping.map($to.pos);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorPos)));
    dispatch(tr.scrollIntoView());
    return true;
  }

  // --- Single character delete ---
  const isBackward = direction === "backward";
  const deletePos = isBackward ? $from.pos - 1 : $from.pos;
  const deleteEnd = isBackward ? $from.pos : $from.pos + 1;

  if (deletePos < 0 || deleteEnd > state.doc.content.size) {
    return true;
  }

  const $deletePos = state.doc.resolve(deletePos);
  const nodeAfter = $deletePos.nodeAfter;

  // At block boundary — let default behavior handle (e.g. join paragraphs)
  if (!nodeAfter?.isText) {
    return false;
  }

  const hasOwnInsertion = nodeAfter.marks.some(
    (m) => m.type === insertionType && m.attrs["author"] === pluginState.author,
  );
  const hasDeletion = nodeAfter.marks.some((m) => m.type === deletionType);

  if (hasDeletion) {
    // Already deleted — skip cursor past it
    const newPos = isBackward ? deletePos : deleteEnd;
    tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
  } else if (hasOwnInsertion) {
    // Retract own insertion — actually delete the character
    tr.delete(deletePos, deleteEnd);
  } else {
    // Mark as deletion instead of removing
    const delAttrs =
      findAdjacentRevisionForRange(
        state.doc,
        deletePos,
        deleteEnd,
        "deletion",
        pluginState.author,
      ) || makeMarkAttrs(pluginState);
    tr.addMark(deletePos, deleteEnd, deletionType.create(delAttrs));
    // Move cursor past the deletion mark
    const newPos = isBackward ? deletePos : deleteEnd;
    tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
  }

  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Create the suggestion mode plugin.
 * When active, text edits become tracked changes.
 */
export function createSuggestionModePlugin(
  initialActive = false,
  author = "User",
): Plugin {
  return new Plugin({
    key: suggestionModeKey,

    state: {
      init(): SuggestionModeState {
        return { active: initialActive, author };
      },
      apply(tr, state): SuggestionModeState {
        const meta = tr.getMeta(suggestionModeKey);
        if (meta) {
          return { ...state, ...meta };
        }
        return state;
      },
    },

    props: {
      handleDOMEvents: {
        // Intercept text input at the DOM level. ProseMirror's handleTextInput
        // is NOT reliably called when the hidden PM has complex mark structures
        // (it requires the change to span exactly one text node). By handling
        // beforeinput directly, we ensure suggestion mode always processes input.
        beforeinput(view: EditorView, event: InputEvent) {
          const pluginState = suggestionModeKey.getState(view.state);
          if (!pluginState?.active) {
            return false;
          }

          if (event.inputType === "insertText" && event.data) {
            event.preventDefault();
            const { from, to } = view.state.selection;
            return applySuggestionInsert(
              view,
              from,
              to,
              event.data,
              pluginState,
            );
          }

          return false;
        },
      },
      // Intercept Enter / Backspace / Delete so paragraph-mark revisions
      // (ECMA-376 §17.13.5) get recorded instead of silently splitting or
      // joining paragraphs.
      handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
        const pluginState = suggestionModeKey.getState(view.state);
        if (!pluginState?.active) {
          return false;
        }

        if (event.key === "Enter") {
          return handleSuggestionEnter(view, pluginState);
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          const boundaryTarget = paragraphBoundaryTarget(
            view.state,
            event.key === "Backspace" ? "backward" : "forward",
          );
          if (boundaryTarget !== null) {
            return applyPPrDel(view, boundaryTarget, pluginState);
          }
          const direction = event.key === "Backspace" ? "backward" : "forward";
          return handleSuggestionDelete(view.state, view.dispatch, direction);
        }
        return false;
      },

      // Backup: also handle via PM's handleTextInput for simple cases
      handleTextInput(
        view: EditorView,
        from: number,
        to: number,
        text: string,
      ): boolean {
        const pluginState = suggestionModeKey.getState(view.state);
        if (!pluginState?.active) {
          return false;
        }
        return applySuggestionInsert(view, from, to, text, pluginState);
      },
    },

    // Catch-all: mark any unhandled new content (e.g. paste) as insertion
    appendTransaction(transactions, _oldState, newState) {
      const pluginState = suggestionModeKey.getState(newState);
      if (!pluginState?.active) {
        return null;
      }

      const userTr = transactions.find(
        (tr) => tr.docChanged && !tr.getMeta(SUGGESTION_META),
      );
      if (!userTr) {
        return null;
      }

      const insertionType = newState.schema.marks["insertion"];
      if (!insertionType) {
        return null;
      }

      const markAttrs = makeMarkAttrs(pluginState);

      const tr = newState.tr;
      tr.setMeta(SUGGESTION_META, true);

      const deletionType = newState.schema.marks["deletion"];
      for (const step of userTr.steps) {
        const stepMap = step.getMap();
        // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror StepMap.forEach
        stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
          if (newTo > newFrom) {
            // Only mark text nodes that don't already have tracked change marks.
            // Marking the entire range would overwrite existing marks from other authors.
            newState.doc.nodesBetween(newFrom, newTo, (node, pos) => {
              if (!node.isText) {
                return;
              }
              const hasTrackedMark = node.marks.some(
                (m) =>
                  m.type === insertionType ||
                  (deletionType && m.type === deletionType),
              );
              if (!hasTrackedMark) {
                const nodeStart = Math.max(pos, newFrom);
                const nodeEnd = Math.min(pos + node.nodeSize, newTo);
                tr.addMark(nodeStart, nodeEnd, insertionType.create(markAttrs));
              }
            });
          }
        });
      }

      return tr.steps.length > 0 ? tr : null;
    },
  });
}

/**
 * Toggle suggestion mode on/off.
 */
export function toggleSuggestionMode(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const current = suggestionModeKey.getState(state);
  if (!current) {
    return false;
  }

  if (dispatch) {
    const tr = state.tr.setMeta(suggestionModeKey, {
      active: !current.active,
    });
    dispatch(tr);
  }
  return true;
}

/**
 * Set suggestion mode active state and author.
 */
export function setSuggestionMode(
  active: boolean,
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
  author?: string,
): boolean {
  if (dispatch) {
    const meta: Partial<SuggestionModeState> = { active };
    if (author !== undefined) {
      meta.author = author;
    }
    const tr = state.tr.setMeta(suggestionModeKey, meta);
    dispatch(tr);
  }
  return true;
}

/**
 * Check if suggestion mode is currently active.
 */
export function isSuggestionModeActive(state: EditorState): boolean {
  return suggestionModeKey.getState(state)?.active ?? false;
}
