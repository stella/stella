import type { JSONContent } from "@tiptap/react";
import type { Transaction } from "prosemirror-state";

import { diffWordSegments } from "@stll/folio-react";

import {
  clauseBodyToTipTap,
  type ParagraphContentOverride,
} from "./clause-editor-tiptap";
import type { ClauseParagraph, ClauseRun } from "./clause-editor-types";
import { DELETION_MARK, INSERTION_MARK } from "./clause-tracked-change-marks";

const TRACKED_AUTHOR = "ai";
const REVISION_IDS_PER_MILLISECOND = 1000;

// "persisting" sits between an AI review resolving and the accepted body
// actually reaching the server: version-save actions must keep treating it
// as unsafe, exactly like "pending", until it settles back to "resolved".
export type ClauseEditorReviewStatus = "resolved" | "pending" | "persisting";

/**
 * Whether the clause body's `Tabs.Panel` must stay mounted even while
 * another tab (Variants/History) is active. Only "pending" needs this: it's
 * the sole status with a live, interactive review UI (the AI edit bar and
 * hunk menu) that resolves the review — Base UI's `Tabs.Panel` unmounts
 * hidden panels by default, and losing that `ClauseEditor` instance strands
 * the review with `reviewStatus` stuck pending and no UI left to resolve it.
 * "persisting" doesn't need this: its persist promise runs independently of
 * `ClauseEditor`'s lifecycle (see `settleReviewPersist`), so it self-heals
 * off the render tree.
 */
export const shouldKeepBodyPanelMounted = (
  status: ClauseEditorReviewStatus,
): boolean => status === "pending";

type InlineMark = NonNullable<JSONContent["marks"]>[number];

type RunCursor = {
  runs: readonly ClauseRun[];
  runIndex: number;
  offset: number;
};

const formattingMarks = (run: ClauseRun): InlineMark[] => {
  const marks: InlineMark[] = [];
  if (run.bold) {
    marks.push({ type: "bold" });
  }
  if (run.italic) {
    marks.push({ type: "italic" });
  }
  return marks;
};

const appendBaselineNodes = (
  nodes: JSONContent[],
  cursor: RunCursor,
  length: number,
  trackedMark?: InlineMark,
): void => {
  let remaining = length;

  while (remaining > 0) {
    const run = cursor.runs[cursor.runIndex];
    if (!run) {
      break;
    }

    const available = run.text.length - cursor.offset;
    if (available === 0) {
      cursor.runIndex += 1;
      cursor.offset = 0;
      continue;
    }

    const taken = Math.min(available, remaining);
    const marks = formattingMarks(run);
    if (trackedMark) {
      marks.push(trackedMark);
    }
    const node: JSONContent = {
      type: "text",
      text: run.text.slice(cursor.offset, cursor.offset + taken),
    };
    if (marks.length > 0) {
      node.marks = marks;
    }
    nodes.push(node);

    cursor.offset += taken;
    remaining -= taken;
    if (cursor.offset === run.text.length) {
      cursor.runIndex += 1;
      cursor.offset = 0;
    }
  }
};

const buildTrackedInline = (
  baseline: ClauseParagraph,
  newText: string,
  revisionId: number,
  date: string,
): JSONContent[] => {
  const nodes: JSONContent[] = [];
  const baselineRuns = baseline.runs ?? [{ text: baseline.text }];
  const runs =
    baselineRuns.map((run) => run.text).join("") === baseline.text
      ? baselineRuns
      : [{ text: baseline.text }];
  const cursor: RunCursor = { runs, runIndex: 0, offset: 0 };
  const trackedAttrs = { revisionId, author: TRACKED_AUTHOR, date };

  for (const segment of diffWordSegments(baseline.text, newText)) {
    if (segment.text === "") {
      continue;
    }
    if (segment.type === "equal") {
      appendBaselineNodes(nodes, cursor, segment.text.length);
      continue;
    }
    if (segment.type === "del") {
      appendBaselineNodes(nodes, cursor, segment.text.length, {
        type: DELETION_MARK,
        attrs: trackedAttrs,
      });
      continue;
    }
    nodes.push({
      type: "text",
      text: segment.text,
      marks: [{ type: INSERTION_MARK, attrs: trackedAttrs }],
    });
  }

  return nodes;
};

type TrackedChangeDoc = {
  doc: JSONContent;
  revisionIds: number[];
};

/**
 * Wrap a ProseMirror `dispatch` so the resulting transaction never lands in
 * the undo stack. Resolving a tracked change (accept/reject one hunk, or
 * accept/reject all) is a system action, not a user edit: leaving it
 * undoable lets Cmd+Z bring the insertion/deletion marks back after the
 * editor has already returned to normal (non-reviewing, editable) mode,
 * where the plain `onUpdate` path would serialize them as resolved text.
 */
export const nonHistoricalDispatch = (
  dispatch: ((tr: Transaction) => void) | undefined,
): ((tr: Transaction) => void) | undefined =>
  dispatch && ((tr) => dispatch(tr.setMeta("addToHistory", false)));

/**
 * Status to report the instant the last tracked-change hunk resolves. A
 * resolution that leaves the body unchanged (e.g. rejecting everything back
 * to the pre-AI text) needs no persist and is immediately safe. A changed
 * resolution isn't safe to snapshot into a version yet: the accepted body
 * still has to reach the server, so callers must stay gated on "persisting"
 * until their own persist call reports success (see {@link
 * settleReviewPersist}) — a failed persist must NOT report "resolved".
 */
export const reviewResolutionStatus = (
  changed: boolean,
): "resolved" | "persisting" => (changed ? "persisting" : "resolved");

/**
 * Fires the persist of an accepted AI body, swallowing an unexpected
 * exception so this fire-and-forget call can never produce an unhandled
 * rejection. Unlike a naive `.then()` chain, this does NOT report the
 * "persisting" gate back to "resolved" on completion: `persist` owns that
 * signal itself (e.g. `ClauseBodyEditor.saveBody` calls
 * `onReviewStatusChange("resolved")` only once its POST actually succeeds,
 * after surfacing its own save-failed toast on error). A failed persist
 * therefore leaves the gate blocked exactly like "pending" — version-save
 * stays disabled — until a later successful persist lifts it: the body
 * editor's normal debounced/blur autosave retries the same call on the next
 * edit, or the user retries by blurring the (already editable) field again.
 */
export const settleReviewPersist = async (
  persist: () => Promise<void>,
): Promise<void> => {
  try {
    await persist();
  } catch {
    // Unexpected persist exceptions surface their own toast inside
    // `persist` (see the caller's save flow); swallow here purely so this
    // fire-and-forget call never produces an unhandled rejection. The
    // "persisting" gate stays blocked — only a successful persist lifts it.
  }
};

export const hasAlignedClauseStructure = (
  baseline: readonly ClauseParagraph[],
  revised: readonly ClauseParagraph[],
): boolean =>
  baseline.length === revised.length &&
  baseline.every((paragraph, index) => {
    const rewrittenParagraph = revised[index];
    if (!rewrittenParagraph) {
      return false;
    }
    if (paragraph.isDirective || rewrittenParagraph.isDirective) {
      return (
        paragraph.isDirective === rewrittenParagraph.isDirective &&
        paragraph.directiveKind === rewrittenParagraph.directiveKind &&
        paragraph.directiveExpression ===
          rewrittenParagraph.directiveExpression &&
        paragraph.text === rewrittenParagraph.text
      );
    }
    return (
      paragraph.style === rewrittenParagraph.style &&
      paragraph.level === rewrittenParagraph.level &&
      paragraph.listKind === rewrittenParagraph.listKind &&
      paragraph.listLevel === rewrittenParagraph.listLevel
    );
  });

export const buildTrackedChangeDoc = (
  baseline: readonly ClauseParagraph[],
  revised: readonly ClauseParagraph[],
): TrackedChangeDoc => {
  const now = Date.now();
  const date = new Date(now).toISOString();
  const revisionIds: number[] = [];
  const idByIndex = new Map<number, number>();

  const count = Math.min(baseline.length, revised.length);
  for (let index = 0; index < count; index += 1) {
    const before = baseline[index];
    const after = revised[index];
    if (!before || !after || before.isDirective || after.isDirective) {
      continue;
    }
    if (before.text === after.text) {
      continue;
    }
    const revisionId = now * REVISION_IDS_PER_MILLISECOND + index;
    idByIndex.set(index, revisionId);
    revisionIds.push(revisionId);
  }

  const override: ParagraphContentOverride = (paragraph, index) => {
    const revisionId = idByIndex.get(index);
    if (revisionId === undefined) {
      return null;
    }
    return buildTrackedInline(
      baseline[index] ?? { text: "" },
      paragraph.text,
      revisionId,
      date,
    );
  };

  return { doc: clauseBodyToTipTap(revised, override), revisionIds };
};
