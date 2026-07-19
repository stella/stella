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
 * another tab (Variants/History) is active. Everything except "resolved"
 * needs this — Base UI's `Tabs.Panel` unmounts hidden panels by default, and
 * losing that `ClauseEditor` instance strands the review with no UI left to
 * recover it. "pending" has a live, interactive review UI (the AI edit bar
 * and hunk menu) that resolves the review. "persisting" has none, but its
 * save outcome is still unknown: if the save fails, the accepted body that
 * would let the user retry exists only in that `ClauseEditor` instance
 * (see `settleReviewPersist`), so unmounting it there is unrecoverable
 * client-side.
 */
export const shouldKeepBodyPanelMounted = (
  status: ClauseEditorReviewStatus,
): boolean => status !== "resolved";

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
 * resolution isn't safe to snapshot into a version yet only when the caller
 * has an incremental persist path (`onReviewResolved`): the accepted body
 * still has to reach the server, so those callers must stay gated on
 * "persisting" until their own persist call reports success (see {@link
 * settleReviewPersist}) — a failed persist must NOT report "resolved".
 * Without `onReviewResolved`, nothing incrementally persists the body — the
 * caller's own save flow (e.g. a create/edit dialog's form submit) persists
 * it later, by design — so there is no async gate to wait on and a changed
 * resolution is immediately "resolved".
 */
export const reviewResolutionStatus = (
  changed: boolean,
  hasPersistHandler: boolean,
): "resolved" | "persisting" =>
  changed && hasPersistHandler ? "persisting" : "resolved";

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

/**
 * Whether a settling `saveBody` call may report the review gate "resolved".
 *
 * `saveBody` is the single persist path behind three very different
 * triggers: the keystroke-debounced autosave, blur, and the review's own
 * flush (`onReviewResolved`). Only the last of those may clear the review
 * gate. Without this guard, a normal autosave that started *before* a review
 * began but settles *after* the editor has already reported
 * "pending"/"persisting" hits `saveBody`'s unconditional success path and
 * flips the gate back to "resolved" while tracked-change hunks are still
 * open (or the real review persist is still in flight) — version-save and
 * leave actions read that gate, so they'd unblock against a stale body.
 *
 * The caller captures a fresh `reviewFlushToken` (an incrementing epoch,
 * same shape as `rewriteRequestIdRef` in `ClauseEditor`) inside
 * `onReviewResolved`, or reads a pending retry token armed by an earlier
 * failed flush (see {@link nextRetryPendingToken}), and threads it into a
 * `saveBody` invocation. Ordinary autosaves that carry neither always
 * resolve to `false` here. Comparing against the *current* epoch (not just
 * checking the token is present) also means a superseded review flush — one
 * review resolves, then a second starts and resolves again before the
 * first's persist settles — can't win a race against the newer one.
 */
export const canReviewFlushReportResolved = (
  reviewFlushToken: number | undefined,
  currentReviewFlushEpoch: number,
): boolean =>
  reviewFlushToken !== undefined &&
  reviewFlushToken === currentReviewFlushEpoch;

/**
 * The token a `saveBody` call should actually carry: its own explicit token
 * if it has one (the review's own flush, minted fresh in `onReviewResolved`),
 * otherwise a pending retry token armed by an earlier failed flush (see
 * {@link nextRetryPendingToken}) — so a later save through *any* trigger
 * (blur, the keystroke debounce) can still be the one that clears the gate.
 *
 * Read this once, synchronously, at the very start of `saveBody`, before the
 * request goes out. That ordering is what keeps the stale-autosave race
 * fixed: an autosave already in flight when a flush fails captured its own
 * `explicitToken` argument (`undefined`) earlier in its call and can't
 * retroactively see a retry token armed after it already started — only a
 * save that starts after the arming reads it.
 */
export const reviewFlushTokenForSave = (
  explicitToken: number | undefined,
  retryPendingToken: number | undefined,
): number | undefined => explicitToken ?? retryPendingToken;

/**
 * The retry token to arm after a `saveBody` call fails, or `undefined` to
 * clear it.
 *
 * Only a failure of a save that was itself allowed to report the gate
 * resolved — the review's own flush, or an earlier armed retry of it — re-
 * arms: a plain autosave failing outside of any review persist has no gate
 * to unblock and must not manufacture one. Re-arming with the *current*
 * epoch (not the failed token verbatim) means a review superseded by a
 * newer one while its retry is still pending can't have a stale retry token
 * wrongly clear the newer review's gate — the newer flush's own explicit
 * token wins instead (see {@link reviewFlushTokenForSave}), and the stale
 * retry token is discarded because it can never match a bumped epoch again.
 *
 * This is what turns a single failed flush into a self-healing gate: fail →
 * arm → next save (any trigger) may resolve; if that save also fails, arm
 * again, repeating until one succeeds.
 */
export const nextRetryPendingToken = (
  reviewFlushToken: number | undefined,
  currentReviewFlushEpoch: number,
): number | undefined =>
  canReviewFlushReportResolved(reviewFlushToken, currentReviewFlushEpoch)
    ? currentReviewFlushEpoch
    : undefined;

/** Stable identity of a body for detecting external resets vs. the editor's
 *  own round-tripped edits (text + formatting + directive kind/expression). */
export const bodyKey = (body: readonly ClauseParagraph[]): string =>
  body
    .map((p) =>
      p.isDirective
        ? `D:${p.directiveKind ?? ""}:${p.directiveExpression ?? ""}`
        : `P:${p.style ?? ""}:${p.level ?? ""}:${p.listKind ?? ""}:${p.listLevel ?? ""}:${(
            p.runs ?? [{ text: p.text }]
          )
            .map((r) => `${r.bold ? "b" : ""}${r.italic ? "i" : ""}|${r.text}`)
            .join("\u0001")}`,
    )
    .join("\u0000");

/**
 * Which body a rewrite request is built from. The "prompting" branch (a
 * fresh AI-edit request, not a regenerate from an open review) must source
 * `liveBody` — the editor's actual on-screen content — rather than any
 * server/query-derived prop: a debounced autosave means that prop can lag
 * behind live keystrokes, and building the rewrite (and later the
 * tracked-change diff) against a stale baseline misaligns hunks and, on
 * accept, silently discards the unsaved edit. This signature takes only
 * `liveBody`, not the stale prop, so that bug can't be reintroduced by
 * wiring the wrong value back in at the call site. The "reviewing" branch
 * (regenerate) reuses the baseline the open review was already built from —
 * the live doc during review holds the AI's tracked-change markup, not
 * plain text, so it can't serve as a rewrite baseline itself.
 */
export const resolveRewriteBaseline = (
  aiEdit:
    | { status: "prompting" }
    | { status: "reviewing"; baseline: readonly ClauseParagraph[] },
  liveBody: readonly ClauseParagraph[],
): readonly ClauseParagraph[] =>
  aiEdit.status === "prompting" ? liveBody : aiEdit.baseline;

/**
 * Whether the editor's live content has drifted from the `baseline` a
 * rewrite request was built from. Used to abort applying a generated
 * suggestion whose tracked-change hunks are index-aligned to `baseline`: if
 * the live doc moved since (e.g. an external content reset synced in
 * mid-generation), applying the diff would corrupt that alignment.
 */
export const isRewriteStale = (
  liveBody: readonly ClauseParagraph[],
  baseline: readonly ClauseParagraph[],
): boolean => bodyKey(liveBody) !== bodyKey(baseline);

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
