import type { Mark, Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

import { buildCleanBlockText } from "./clean-text";
import { hashFolioAIBlockText, normalizeFolioAIBlockText } from "./snapshot";
import type {
  FolioAIEditAppliedOperation,
  FolioAIEditApplyMode,
  FolioAIEditApplyResult,
  FolioAIEditOperation,
  FolioAIEditSnapshot,
  FolioAIEditSkipReason,
  FolioAIEditSkippedOperation,
} from "./types";
import { diffWordSegments } from "./word-diff";

type FolioAIEditView = {
  state: EditorState;
  dispatch: (transaction: Transaction) => void;
};

type ApplyFolioAIEditOperationsOptions = {
  view: FolioAIEditView;
  snapshot: FolioAIEditSnapshot;
  operations: FolioAIEditOperation[];
  mode?: FolioAIEditApplyMode;
  author?: string;
  createCommentId?: (text: string) => number;
};

type ResolvedOperation = {
  operation: FolioAIEditOperation;
  from: number;
  to: number;
  blockFrom: number;
  blockTo: number;
  blockNode: PMNode;
  insertText?: string;
  commentId?: number;
  /**
   * Position in the input `operations` array, used as a secondary
   * sort key so same-position operations preserve the AI's logical
   * ordering when applied bottom-up.
   */
  originalIndex: number;
};

/**
 * Block attrs that identify a block instance (Word's
 * `w14:paraId` / `w14:textId`, future tracked-change identifiers).
 * Reuse during inheritFormatting would create duplicate IDs, so
 * we strip them when synthesising a sibling.
 */
const IDENTITY_BLOCK_ATTRS = new Set(["paraId", "textId"]);

const stripIdentityAttrs = (attrs: Record<string, unknown>) => {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (IDENTITY_BLOCK_ATTRS.has(key)) {
      next[key] = null;
      continue;
    }
    next[key] = value;
  }
  return next;
};

type LiveBlockEntry = { from: number; to: number; node: PMNode };

/**
 * Module-scoped monotonic counter for tracked-change revision ids.
 * Seeded once from `Date.now()` so ids are roughly time-ordered for
 * humans reading raw DOCX, then incremented per allocation. A bare
 * `Date.now()` seed per applyAIEditOperations call would collide
 * across batches that fire within the same millisecond (the panel's
 * Accept-all loop does exactly that — multiple calls in tight
 * succession). Reserving a contiguous range up front guarantees
 * uniqueness across overlapping calls in the same JS realm.
 */
let revisionIdCursor = Date.now() * 1000;
const nextRevisionSeed = (count: number): number => {
  // Each replace allocates two ids per op; insert/delete one each.
  // Reserve `count * 4` to be safely above any conceivable per-op
  // allocation (current max is 2). Returning the start of the
  // reserved range as the seed is enough — the caller bumps it.
  const start = revisionIdCursor;
  revisionIdCursor += Math.max(count, 1) * 4;
  return start;
};

/**
 * Walk the live doc once and bucket every textblock by its
 * normalised text hash. Resolution then maps each snapshot anchor
 * to the live block at the same ordinal among same-hash siblings —
 * unrelated edits that shift absolute positions no longer break
 * the lookup, and a sibling sharing text content with the target
 * doesn't trigger a false "changed" skip either.
 */
const collectLiveBlocksByHash = (doc: PMNode) => {
  const byHash = new Map<string, LiveBlockEntry[]>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return;
    }
    // Hash from the post-tracked-changes view so the snapshot
    // (taken with the same view) and live doc bucket the same
    // block under the same key. Otherwise a block mid-edit gets a
    // different hash than the snapshot recorded and the resolver
    // skips it as "changed".
    const cleanText = buildCleanBlockText(node, pos).text;
    const hash = hashFolioAIBlockText(normalizeFolioAIBlockText(cleanText));
    const bucket = byHash.get(hash) ?? [];
    bucket.push({ from: pos, to: pos + node.nodeSize, node });
    byHash.set(hash, bucket);
  });
  return byHash;
};

/**
 * The snapshot recorded an `hashOccurrenceCount` per anchor but
 * not which ordinal within that bucket the block was — recompute
 * on demand from the snapshot's anchor map. Stable iteration
 * (object insertion order) means anchors with the same hash come
 * out in document order, which is what we want.
 */
const ordinalAmongSameHash = (
  snapshot: FolioAIEditSnapshot,
  blockId: string,
): number => {
  const target = snapshot.anchors[blockId];
  if (!target) {
    return -1;
  }
  let ordinal = 0;
  for (const anchor of Object.values(snapshot.anchors)) {
    if (anchor.id === blockId) {
      return ordinal;
    }
    if (anchor.textHash === target.textHash) {
      ordinal += 1;
    }
  }
  return -1;
};

export const applyFolioAIEditOperations = ({
  view,
  snapshot,
  operations,
  mode = "tracked-changes",
  author = "AI",
  createCommentId,
}: ApplyFolioAIEditOperationsOptions): FolioAIEditApplyResult => {
  const applied: FolioAIEditAppliedOperation[] = [];
  const skipped: FolioAIEditSkippedOperation[] = [];
  const resolved: ResolvedOperation[] = [];
  const insertionType = view.state.schema.marks["insertion"];
  const deletionType = view.state.schema.marks["deletion"];
  const commentType = view.state.schema.marks["comment"];

  if (mode === "tracked-changes" && (!insertionType || !deletionType)) {
    return {
      applied,
      skipped: operations.map((operation) => ({
        id: operation.id,
        reason: "unsupportedBlock",
      })),
    };
  }

  // Build the live-block index once per batch so individual op
  // resolutions don't each re-walk the doc.
  const liveBlocks = collectLiveBlocksByHash(view.state.doc);

  for (const [index, operation] of operations.entries()) {
    const commentText = getOperationCommentText(operation);
    if (
      commentText !== undefined &&
      (!commentType || createCommentId === undefined)
    ) {
      skipped.push({ id: operation.id, reason: "unsupportedBlock" });
      continue;
    }

    const resolution = resolveOperation(snapshot, operation, liveBlocks);
    if (resolution.type === "skip") {
      skipped.push({ id: operation.id, reason: resolution.reason });
      continue;
    }

    const commentId =
      commentText !== undefined ? createCommentId?.(commentText) : undefined;
    resolved.push({
      ...resolution.operation,
      originalIndex: index,
      ...(commentId !== undefined && { commentId }),
    });
  }

  if (resolved.length === 0) {
    return { applied, skipped };
  }

  let tr = view.state.tr;
  let revisionSeed = nextRevisionSeed(resolved.length);
  const date = new Date().toISOString();

  // Sort right-to-left so each tr.insert / tr.delete leaves
  // earlier positions intact. For ties on `from` we order by
  // `originalIndex` DESC: applied in reverse, that means the
  // earlier-listed op lands at the original anchor and the later
  // one ends up immediately after it, matching the AI's logical
  // sequence.
  for (const item of resolved.toSorted((left, right) => {
    if (left.from !== right.from) {
      return right.from - left.from;
    }
    return right.originalIndex - left.originalIndex;
  })) {
    const commentMark =
      item.commentId !== undefined && commentType
        ? commentType.create({ commentId: item.commentId })
        : null;

    // Snapshot the transaction's step count so we can detect when an
    // operation produced zero document changes and report it as a
    // skipped no-op instead of a phantom "applied" entry. This caught
    // the silent accept-failure bug where a replaceInBlock on a
    // block with pending tracked changes computed the wrong source
    // text and the diff produced no marks; the panel said "accepted"
    // but the doc was untouched.
    const stepsBefore = tr.steps.length;
    let appliedRevisionIds: number[] | undefined;

    switch (item.operation.type) {
      case "replaceInBlock": {
        const revisionIdDelete = revisionSeed++;
        const revisionIdInsert = revisionSeed++;
        tr = applyTextReplacement({
          tr,
          item,
          mode,
          author,
          date,
          revisionIdDelete,
          revisionIdInsert,
          commentMark,
        });
        if (mode === "tracked-changes") {
          appliedRevisionIds = [revisionIdDelete, revisionIdInsert];
        }
        break;
      }
      case "replaceBlock": {
        const revisionIdDelete = revisionSeed++;
        const revisionIdInsert = revisionSeed++;
        // Default to preserving formatting (existing behaviour);
        // when explicitly disabled and we're in direct mode, swap
        // the whole block node for a fresh paragraph that drops
        // all block-level attrs. tracked-changes mode keeps the
        // attrs because the visible diff is text-only.
        if (item.operation.preserveFormatting === false && mode === "direct") {
          const replacement = item.operation.text;
          const paragraphType = view.state.schema.nodes["paragraph"];
          if (paragraphType) {
            const node = paragraphType.create(
              null,
              replacement.length === 0
                ? null
                : view.state.schema.text(replacement),
            );
            tr = tr.replaceWith(item.blockFrom, item.blockTo, node);
            break;
          }
        }
        tr = applyTextReplacement({
          tr,
          item,
          mode,
          author,
          date,
          revisionIdDelete,
          revisionIdInsert,
          commentMark,
        });
        if (mode === "tracked-changes") {
          appliedRevisionIds = [revisionIdDelete, revisionIdInsert];
        }
        break;
      }
      case "insertAfterBlock":
      case "insertBeforeBlock": {
        const marks = [];
        if (mode === "tracked-changes" && insertionType) {
          const revisionId = revisionSeed++;
          marks.push(
            insertionType.create({
              revisionId,
              author,
              date,
            }),
          );
          appliedRevisionIds = [revisionId];
        }
        if (commentMark) {
          marks.push(commentMark);
        }
        const content =
          item.insertText && item.insertText.length > 0
            ? view.state.schema.text(item.insertText, marks)
            : null;
        // Inherit formatting attrs (listMarker, styleId, …) from
        // the source block but never reuse identity attrs — a new
        // paragraph must get fresh paraId/textId so trackers don't
        // collide.
        const attrs =
          item.operation.inheritFormatting === false
            ? {}
            : stripIdentityAttrs(item.blockNode.attrs);
        const node = item.blockNode.type.create(attrs, content);
        tr = tr.insert(item.from, node);
        break;
      }
      case "deleteBlock": {
        if (mode === "direct") {
          tr = tr.delete(item.blockFrom, item.blockTo);
          break;
        }

        if (deletionType) {
          const revisionId = revisionSeed++;
          tr = tr.addMark(
            item.from,
            item.to,
            deletionType.create({
              revisionId,
              author,
              date,
            }),
          );
          appliedRevisionIds = [revisionId];
        }
        if (commentMark) {
          tr = tr.addMark(item.from, item.to, commentMark);
        }
        break;
      }
      case "commentOnBlock": {
        if (commentMark) {
          tr = tr.addMark(item.from, item.to, commentMark);
        }
        break;
      }
      default:
        break;
    }

    // commentOnBlock is intentionally a doc-mutation-free op
    // (adds a mark; that DOES count as a step) but covers the
    // edge case where the comment mark is missing. Treat any op
    // that emitted zero transaction steps as a no-op skip.
    if (tr.steps.length === stepsBefore) {
      skipped.push({ id: item.operation.id, reason: "noopOperation" });
      continue;
    }

    // Surface the primary id (first one) on the legacy `revisionId`
    // field so callers that just need a stable scroll/visual
    // reference keep working. The full set is on `revisionIds` for
    // accept/reject paths that must clear every mark belonging to
    // this op.
    applied.push({
      id: item.operation.id,
      ...(item.commentId !== undefined && { commentId: item.commentId }),
      ...(appliedRevisionIds !== undefined &&
        appliedRevisionIds[0] !== undefined && {
          revisionId: appliedRevisionIds[0],
          revisionIds: appliedRevisionIds,
        }),
    });
  }

  if (tr.docChanged) {
    view.dispatch(tr);
  }

  return { applied, skipped };
};

type TextReplacementOptions = {
  tr: Transaction;
  item: ResolvedOperation;
  mode: FolioAIEditApplyMode;
  author: string;
  date: string;
  /**
   * Distinct revision id used for the deletion-side marks.
   * fromProseDoc treats a single revisionId carrying BOTH ins and
   * del marks as a Word "moveTo/moveFrom" pair on serialization,
   * which is wrong for an AI replace — so the engine allocates one
   * id for the deletion side and a separate one for the insertion
   * side of the same operation.
   */
  revisionIdDelete: number;
  /** Distinct revision id used for the insertion-side marks. */
  revisionIdInsert: number;
  commentMark: Mark | null;
};

const applyTextReplacement = ({
  tr,
  item,
  mode,
  author,
  date,
  revisionIdDelete,
  revisionIdInsert,
  commentMark,
}: TextReplacementOptions): Transaction => {
  let nextTr = tr;
  const replacement =
    item.operation.type === "replaceInBlock"
      ? item.operation.replace
      : item.operation.type === "replaceBlock"
        ? item.operation.text
        : "";

  if (mode === "direct") {
    nextTr = nextTr.insertText(replacement, item.from, item.to);
    if (commentMark && replacement.length > 0) {
      nextTr = nextTr.addMark(
        item.from,
        item.from + replacement.length,
        commentMark,
      );
    }
    return nextTr;
  }

  const insertionType = nextTr.doc.type.schema.marks["insertion"];
  const deletionType = nextTr.doc.type.schema.marks["deletion"];
  const delAttrs = { revisionId: revisionIdDelete, author, date };
  const insAttrs = { revisionId: revisionIdInsert, author, date };

  // Word-level diff is only safe when the source range maps to PM
  // positions losslessly. The block must have no atomic inline
  // nodes (hard breaks, inline images) — those break textContent /
  // PM-position alignment in ways the offsets array can't resolve.
  //
  // Existing tracked-change marks ARE handled here: we walk PM
  // positions through `cleanBlock.offsets[]` (built from the
  // post-tracked-changes view), so each clean-text char anchors at
  // the right live position even when the block has pending
  // deletion runs interleaved between surviving chars. Naively
  // accumulating `cursor += seg.text.length` would skip the gap
  // introduced by those deletion runs and write marks onto the
  // wrong live characters — the silent accept-failure bug.
  const blockHasOnlyTextChildren =
    item.blockNode.content.size === item.blockNode.textContent.length;
  const cleanBlock = blockHasOnlyTextChildren
    ? buildCleanBlockText(item.blockNode, item.blockFrom)
    : null;
  let sourceText: string | null = null;
  let sourceCleanStart = 0;
  if (cleanBlock !== null) {
    if (item.operation.type === "replaceInBlock") {
      sourceText = item.operation.find;
      sourceCleanStart = cleanBlock.text.indexOf(item.operation.find);
      if (sourceCleanStart === -1) {
        sourceText = null;
      }
    } else if (item.operation.type === "replaceBlock") {
      sourceText = cleanBlock.text;
      sourceCleanStart = 0;
    }
  }

  if (sourceText !== null && cleanBlock !== null) {
    const segments = diffWordSegments(sourceText, replacement);
    const offsets = cleanBlock.offsets;
    const offsetAt = (cleanOffset: number): number | null =>
      offsets[cleanOffset] ?? null;

    type Step =
      | { kind: "del"; from: number; to: number }
      | { kind: "ins"; at: number; text: string };
    const steps: Step[] = [];
    // Cursor walks SOURCE-text offsets (within `sourceText`), then
    // we translate to PM positions through offsets[]. This survives
    // gaps caused by existing deletion-marked runs in the live doc.
    let cursor = 0;
    let allPositionsResolved = true;
    for (const seg of segments) {
      if (seg.type === "equal") {
        cursor += seg.text.length;
        continue;
      }
      if (seg.type === "del") {
        const pmFrom = offsetAt(sourceCleanStart + cursor);
        const pmTo = offsetAt(sourceCleanStart + cursor + seg.text.length);
        if (pmFrom === null || pmTo === null) {
          allPositionsResolved = false;
          break;
        }
        steps.push({ kind: "del", from: pmFrom, to: pmTo });
        cursor += seg.text.length;
        continue;
      }
      const pmAt = offsetAt(sourceCleanStart + cursor);
      if (pmAt === null) {
        allPositionsResolved = false;
        break;
      }
      steps.push({ kind: "ins", at: pmAt, text: seg.text });
    }

    if (allPositionsResolved) {
      // Apply right-to-left so earlier steps' source positions stay
      // valid after later steps mutate the doc.
      for (const step of steps.toReversed()) {
        if (step.kind === "del" && deletionType) {
          nextTr = nextTr.addMark(
            step.from,
            step.to,
            deletionType.create(delAttrs),
          );
          if (commentMark) {
            nextTr = nextTr.addMark(step.from, step.to, commentMark);
          }
          continue;
        }
        if (step.kind === "ins" && insertionType) {
          nextTr = nextTr.insertText(step.text, step.at, step.at);
          nextTr = nextTr.addMark(
            step.at,
            step.at + step.text.length,
            insertionType.create(insAttrs),
          );
          if (commentMark) {
            nextTr = nextTr.addMark(
              step.at,
              step.at + step.text.length,
              commentMark,
            );
          }
        }
      }
      return nextTr;
    }
    // else fall through to the coarse del+ins path below: the
    // offsets array didn't cover one of our boundaries, which only
    // happens for edge cases at the trailing block boundary.
  }

  if (replacement.length > 0 && insertionType) {
    nextTr = nextTr.insertText(replacement, item.to, item.to);
    nextTr = nextTr.addMark(
      item.to,
      item.to + replacement.length,
      insertionType.create(insAttrs),
    );
    if (commentMark) {
      nextTr = nextTr.addMark(
        item.to,
        item.to + replacement.length,
        commentMark,
      );
    }
  }

  if (item.to > item.from && deletionType) {
    nextTr = nextTr.addMark(item.from, item.to, deletionType.create(delAttrs));
    if (commentMark && replacement.length === 0) {
      nextTr = nextTr.addMark(item.from, item.to, commentMark);
    }
  }

  return nextTr;
};

type ResolvedBase = Omit<ResolvedOperation, "originalIndex" | "commentId">;

const resolveOperation = (
  snapshot: FolioAIEditSnapshot,
  operation: FolioAIEditOperation,
  liveBlocks: Map<string, LiveBlockEntry[]>,
): { type: "resolved"; operation: ResolvedBase } | OperationResolutionSkip => {
  const anchor = snapshot.anchors[operation.blockId];
  if (!anchor) {
    return { type: "skip", reason: "missingBlock" };
  }

  const ordinal = ordinalAmongSameHash(snapshot, operation.blockId);
  if (ordinal < 0) {
    return { type: "skip", reason: "missingBlock" };
  }
  const live = liveBlocks.get(anchor.textHash)?.[ordinal];
  if (!live || !live.node.isTextblock) {
    return { type: "skip", reason: "changedBlock" };
  }

  const blockNode = live.node;
  const blockFrom = live.from;
  const blockTo = live.to;
  // Use the same post-tracked-changes view the AI was given, so its
  // find / replaceBlock anchors line up with what it saw.
  const cleanBlock = buildCleanBlockText(blockNode, blockFrom);
  const currentText = cleanBlock.text;

  if (
    operation.type === "insertAfterBlock" ||
    operation.type === "insertBeforeBlock"
  ) {
    if (operation.text.length === 0) {
      return { type: "skip", reason: "emptyOperation" };
    }
    return {
      type: "resolved",
      operation: {
        operation,
        from: operation.type === "insertAfterBlock" ? blockTo : blockFrom,
        to: operation.type === "insertAfterBlock" ? blockTo : blockFrom,
        blockFrom,
        blockTo,
        blockNode,
        insertText: operation.text,
      },
    };
  }

  if (operation.type === "deleteBlock" || operation.type === "replaceBlock") {
    const range = getTextRangeFromCleanBlock(cleanBlock);
    if (!range) {
      // Empty block. The AI never sees these — the snapshot
      // explicitly skips blocks whose normalised text is empty,
      // so by construction the resolver only ever lands here on a
      // block that was non-empty at snapshot time and got emptied
      // between snapshot and apply. The textHash gate above would
      // already have rejected that case as `changedBlock`, so this
      // branch is unreachable through the real flow; keeping the
      // skip as a defensive guard.
      return { type: "skip", reason: "unsupportedBlock" };
    }
    // The model occasionally emits replaceBlock with text identical
    // to the live block's clean text — usually as a side effect of
    // running through a "review every block" pass. Skip so the
    // panel doesn't show an empty redline (verified in dev-tools
    // trace where one such op surfaced as "Prodávající 3 →
    // Prodávající 3").
    if (operation.type === "replaceBlock" && operation.text === currentText) {
      return { type: "skip", reason: "noopOperation" };
    }
    return {
      type: "resolved",
      operation: {
        operation,
        from: range.from,
        to: range.to,
        blockFrom,
        blockTo,
        blockNode,
      },
    };
  }

  if (
    operation.type === "replaceInBlock" &&
    operation.find === operation.replace
  ) {
    return { type: "skip", reason: "noopOperation" };
  }

  const quote = getOperationQuote(operation);
  const range = resolveTextInCleanBlock(cleanBlock, quote || currentText);
  if (range.type !== "resolved") {
    return range;
  }

  return {
    type: "resolved",
    operation: {
      operation,
      from: range.from,
      to: range.to,
      blockFrom,
      blockTo,
      blockNode,
    },
  };
};

type OperationResolutionSkip = { type: "skip"; reason: FolioAIEditSkipReason };

const resolveTextInCleanBlock = (
  cleanBlock: { text: string; offsets: number[] },
  find: string,
):
  | { type: "resolved"; from: number; to: number }
  | { type: "skip"; reason: FolioAIEditSkipReason } => {
  if (find.length === 0) {
    return { type: "skip", reason: "emptyOperation" };
  }

  const { text, offsets } = cleanBlock;
  const firstIndex = text.indexOf(find);
  if (firstIndex === -1) {
    return { type: "skip", reason: "missingFind" };
  }
  if (text.includes(find, firstIndex + 1)) {
    return { type: "skip", reason: "ambiguousFind" };
  }

  const from = offsets[firstIndex];
  const to = offsets[firstIndex + find.length];
  if (from === undefined || to === undefined) {
    return { type: "skip", reason: "unsupportedBlock" };
  }

  return { type: "resolved", from, to };
};

const getTextRangeFromCleanBlock = (cleanBlock: {
  text: string;
  offsets: number[];
}): { from: number; to: number } | null => {
  if (cleanBlock.text.length === 0) {
    return null;
  }
  const from = cleanBlock.offsets[0];
  const to = cleanBlock.offsets[cleanBlock.text.length];
  if (from === undefined || to === undefined) {
    return null;
  }
  return { from, to };
};

const getOperationCommentText = (
  operation: FolioAIEditOperation,
): string | undefined => operation.comment?.text;

const getOperationQuote = (
  operation: FolioAIEditOperation,
): string | undefined => {
  if (operation.type === "replaceInBlock") {
    return operation.find;
  }
  if (operation.type === "commentOnBlock") {
    return operation.quote;
  }
  return undefined;
};
