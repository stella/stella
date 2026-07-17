/**
 * Shared builders for AI DOCX review suggestions.
 *
 * These pure helpers turn a folio edit operation plus the block
 * snapshot the AI saw into the panel-facing shape: a human summary,
 * the anchoring block id, the reviewer comment, and the inline
 * redline preview. They are extracted here (rather than living in
 * the chat overlay) so hydration — rebuilding persisted suggestions
 * from their stored `opPayload` on reload — reuses the exact same
 * derivation the live queue path uses. Keep them free of React and
 * of chat/tool-input shapes.
 */

import type {
  FolioAIEditOperation,
  FolioAIEditSnapshot,
} from "@stll/folio-react";

import type { ReviewSuggestionPreview } from "@/components/ai-suggestions/review-store";

/**
 * A single block as the AI saw it at proposal time. Structurally a
 * subset of `FolioAIEditSnapshot["blocks"][number]`, so a snapshot's
 * blocks can be fed straight in.
 */
export type SnapshotBlock = {
  id: string;
  text: string;
  displayLabel?: string | undefined;
  styleId?: string;
  previewRuns?: FolioAIEditSnapshot["blocks"][number]["previewRuns"];
};

export const PREVIEW_CONTEXT_CHARS = 60;
export const PREVIEW_ANCHOR_CHARS = 80;

export const summarizeOperation = (operation: FolioAIEditOperation): string => {
  switch (operation.type) {
    case "replaceInBlock":
      return `Replace “${operation.find}” with “${operation.replace}”`;
    case "replaceBlock":
      return `Replace block ${operation.blockId}`;
    case "insertAfterBlock":
    case "insertBeforeBlock": {
      const direction =
        operation.type === "insertAfterBlock" ? "after" : "before";
      if (operation.pageBreakBefore === true && operation.text.length === 0) {
        return `Insert page break ${direction} ${operation.blockId}`;
      }
      if (operation.styleId !== undefined) {
        return `Insert ${operation.styleId} ${direction} ${operation.blockId}: ${operation.text}`;
      }
      return `Insert ${direction} ${operation.blockId}: ${operation.text}`;
    }
    case "deleteBlock":
      return `Delete block ${operation.blockId}`;
    case "commentOnBlock":
      return `Comment on ${operation.blockId}`;
    case "insertSignatureTable": {
      const names = operation.parties.map((p) => p.name).join(", ");
      return `Insert signature table for ${names}`;
    }
    case "replaceRange":
      return `Replace selected text with “${operation.replace}”`;
    case "commentOnRange":
      return "Comment on selected text";
    case "formatRange":
      return "Format selected text";
    default:
      operation satisfies never;
      return "";
  }
};

/** The block a folio operation anchors to; range ops carry it on the handle. */
export const folioOperationBlockId = (
  operation: FolioAIEditOperation,
): string =>
  operation.type === "replaceRange" ||
  operation.type === "commentOnRange" ||
  operation.type === "formatRange"
    ? operation.range.blockId
    : operation.blockId;

export const folioOperationComment = (operation: FolioAIEditOperation) =>
  operation.type === "formatRange" ? undefined : operation.comment;

/**
 * Build a redline preview for one operation against the snapshot
 * the AI saw. Returns `null` when the operation references a block
 * we don't have (rare, but defensive — e.g. the snapshot expired
 * mid-stream and the AI got an outdated copy).
 */
export const buildPreview = (
  operation: FolioAIEditOperation,
  blocksById: Map<string, SnapshotBlock>,
): ReviewSuggestionPreview | null => {
  const block = blocksById.get(folioOperationBlockId(operation));
  const blockText = block?.text ?? "";
  switch (operation.type) {
    // `formatRange` is outside this tool's accepted subset (direct-only
    // apply mode; the review flow is tracked-changes). Skip defensively
    // if one ever appears on a stored suggestion.
    case "formatRange":
      return null;
    // Range-addressed edits render with the replaceInBlock preview: the
    // handle's offsets locate the replaced text inside the snapshot block
    // the same way a `find` match does.
    case "replaceRange": {
      if (block === undefined) {
        return null;
      }
      const start = operation.range.startOffset;
      const end = Math.min(operation.range.endOffset, blockText.length);
      if (start >= end) {
        return null;
      }
      const contextStart = Math.max(0, start - PREVIEW_CONTEXT_CHARS);
      const contextEnd = Math.min(
        blockText.length,
        end + PREVIEW_CONTEXT_CHARS,
      );
      return {
        type: "replaceInBlock",
        contextBefore: blockText.slice(contextStart, start),
        before: blockText.slice(start, end),
        after: operation.replace,
        contextAfter: blockText.slice(end, contextEnd),
        ...(block.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
          contextStart,
          matchStart: start,
          matchEnd: end,
          contextEnd,
        }),
      };
    }
    // Anchored like commentOnBlock with a quote: the sliced range text is
    // the anchor, so no anchorRuns (those render from the block start).
    case "commentOnRange": {
      if (block === undefined) {
        return null;
      }
      const start = operation.range.startOffset;
      const end = Math.min(operation.range.endOffset, blockText.length);
      const anchor =
        start < end
          ? blockText.slice(start, end)
          : blockText.slice(0, PREVIEW_ANCHOR_CHARS);
      return { type: "commentOnBlock", anchor };
    }
    case "replaceInBlock": {
      const idx = blockText.indexOf(operation.find);
      if (idx === -1) {
        return {
          type: "replaceInBlock",
          contextBefore: blockText.slice(0, PREVIEW_CONTEXT_CHARS),
          before: operation.find,
          after: operation.replace,
          contextAfter: "",
          ...(block?.previewRuns !== undefined && {
            sourceRuns: block.previewRuns,
          }),
        };
      }
      const contextStart = Math.max(0, idx - PREVIEW_CONTEXT_CHARS);
      const matchEnd = idx + operation.find.length;
      const contextEnd = Math.min(
        blockText.length,
        matchEnd + PREVIEW_CONTEXT_CHARS,
      );
      return {
        type: "replaceInBlock",
        contextBefore: blockText.slice(contextStart, idx),
        before: operation.find,
        after: operation.replace,
        contextAfter: blockText.slice(matchEnd, contextEnd),
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
          contextStart,
          matchStart: idx,
          matchEnd,
          contextEnd,
        }),
      };
    }
    case "replaceBlock":
      return {
        type: "replaceBlock",
        before: blockText,
        after: operation.text,
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
        }),
      };
    case "deleteBlock":
      return {
        type: "deleteBlock",
        before: blockText,
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
        }),
      };
    case "insertBeforeBlock":
    case "insertAfterBlock":
      return {
        type: operation.type,
        anchor: blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        after: operation.text,
        ...(block?.previewRuns !== undefined && {
          anchorRuns: block.previewRuns,
          anchorEnd: Math.min(blockText.length, PREVIEW_ANCHOR_CHARS),
        }),
      };
    case "commentOnBlock":
      return {
        type: "commentOnBlock",
        anchor: operation.quote ?? blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        ...(operation.quote === undefined &&
          block?.previewRuns !== undefined && {
            anchorRuns: block.previewRuns,
            anchorEnd: Math.min(blockText.length, PREVIEW_ANCHOR_CHARS),
          }),
      };
    case "insertSignatureTable":
      return {
        type: "insertSignatureTable",
        anchor: blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        parties: operation.parties.map((p) => ({
          name: p.name,
          ...(p.signatory !== undefined && { signatory: p.signatory }),
          ...(p.title !== undefined && { title: p.title }),
        })),
        position: operation.position ?? "after",
        ...(block?.previewRuns !== undefined && {
          anchorRuns: block.previewRuns,
          anchorEnd: Math.min(blockText.length, PREVIEW_ANCHOR_CHARS),
        }),
      };
    default:
      operation satisfies never;
      return null;
  }
};
