import { panic } from "better-result";
import type { Node as ProseMirrorNode } from "prosemirror-model";

import {
  resolveFolioAIBlockRange,
  resolveFolioAITextRange,
  resolvePassageRange,
} from "@stll/folio-core/ai-edits";
import type { AISuggestion } from "@stll/folio-react";

import type { ReviewSuggestion } from "./review-store";

const severityForFolio = (
  severity: ReviewSuggestion["severity"],
): AISuggestion["severity"] => {
  switch (severity) {
    case "low":
      return "typo";
    case "medium":
    case "unspecified":
      return "style";
    case "high":
      return "substantive";
    default:
      severity satisfies never;
      return panic(`Unhandled severity: ${String(severity)}`);
  }
};

type TextualSuggestion = Pick<
  AISuggestion,
  "contextAfter" | "contextBefore" | "originalText" | "range" | "suggestedText"
>;

type ResolveBlockReplacementOptions = {
  blockText: string;
  blockTextFrom: number;
  replacementText: string;
};

const MAX_INLINE_BLOCK_REPLACEMENT_CHARS = 48;

/**
 * Folio's paged suggestion overlay can preview one inline replacement, but it
 * does not reflow an entire replacement block. Reduce a block rewrite to the
 * smallest contiguous changed span so the preview remains inside the document
 * layout. A pure insertion has no source range for Folio to decorate, so it
 * stays in the review panel instead of manufacturing a misleading range.
 */
const resolveBlockReplacement = ({
  blockText,
  blockTextFrom,
  replacementText,
}: ResolveBlockReplacementOptions): TextualSuggestion | null => {
  let prefixLength = 0;
  const sharedLength = Math.min(blockText.length, replacementText.length);
  while (
    prefixLength < sharedLength &&
    blockText[prefixLength] === replacementText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < sharedLength - prefixLength &&
    blockText[blockText.length - 1 - suffixLength] ===
      replacementText[replacementText.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const originalEnd = blockText.length - suffixLength;
  if (prefixLength === originalEnd) {
    return null;
  }

  const replacementEnd = replacementText.length - suffixLength;
  const originalText = blockText.slice(prefixLength, originalEnd);
  const suggestedText = replacementText.slice(prefixLength, replacementEnd);
  if (
    originalText.length > MAX_INLINE_BLOCK_REPLACEMENT_CHARS ||
    suggestedText.length > MAX_INLINE_BLOCK_REPLACEMENT_CHARS ||
    suggestedText.includes("\n")
  ) {
    return null;
  }
  return {
    contextAfter: blockText.slice(originalEnd),
    contextBefore: blockText.slice(0, prefixLength),
    originalText,
    range: {
      from: blockTextFrom + prefixLength,
      to: blockTextFrom + originalEnd,
    },
    suggestedText,
  };
};

const resolveTextualSuggestion = (
  item: ReviewSuggestion,
  doc: ProseMirrorNode,
): TextualSuggestion | null => {
  const operation = item.pendingOperation;
  if (operation === null) {
    return null;
  }

  switch (operation.type) {
    case "replaceInBlock": {
      const range = resolvePassageRange({
        blockId: operation.blockId,
        doc,
        snapshot: item.snapshot,
        text: operation.find,
      });
      if (range === null) {
        return null;
      }
      return {
        contextAfter:
          item.preview.type === "replaceInBlock"
            ? item.preview.contextAfter
            : "",
        contextBefore:
          item.preview.type === "replaceInBlock"
            ? item.preview.contextBefore
            : "",
        originalText: operation.find,
        range,
        suggestedText: operation.replace,
      };
    }
    case "replaceRange": {
      const range = resolveFolioAITextRange({
        range: operation.range,
        doc,
        snapshot: item.snapshot,
      });
      if (range === null) {
        return null;
      }
      return {
        contextAfter: "",
        contextBefore: "",
        originalText: doc.textBetween(range.from, range.to),
        range,
        suggestedText: operation.replace,
      };
    }
    case "replaceBlock":
    case "deleteBlock": {
      const blockRange = resolveFolioAIBlockRange({
        blockId: operation.blockId,
        doc,
        snapshot: item.snapshot,
      });
      if (blockRange === null || blockRange.to - blockRange.from <= 2) {
        return null;
      }
      const range = {
        from: blockRange.from + 1,
        to: blockRange.to - 1,
      };
      const blockText = doc.textBetween(range.from, range.to);
      if (operation.type === "replaceBlock") {
        return resolveBlockReplacement({
          blockText,
          blockTextFrom: range.from,
          replacementText: operation.text,
        });
      }
      return {
        contextAfter: "",
        contextBefore: "",
        originalText: blockText,
        range,
        suggestedText: "",
      };
    }
    // No inline diff to draw. A paragraph break moved or removed
    // (`splitBlock`, `mergeBlockWithNext`), a whole table, and a paragraph's
    // style or list level are edits to the document's structure, not to the
    // words of one block: rendering them as a text replacement would tell the
    // reviewer that Accept rewrites text it does not touch.
    case "commentOnRange":
    case "formatRange":
    case "setBlockParagraphProperties":
    case "commentOnBlock":
    case "splitBlock":
    case "mergeBlockWithNext":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "insertSignatureTable":
    case "insertTable":
    case "deleteTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return null;
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};

/**
 * Translate operation-shaped review items into Folio's non-mutating inline
 * diffs. Structural edits stay in the review panel because presenting them as
 * text replacements would misrepresent what Accept will do.
 */
export const buildFolioReviewDecorations = (
  items: readonly ReviewSuggestion[],
  doc: ProseMirrorNode,
): AISuggestion[] =>
  items.flatMap((item) => {
    if (item.status !== "pending") {
      return [];
    }
    const textual = resolveTextualSuggestion(item, doc);
    if (textual === null) {
      return [];
    }
    return [
      {
        ...textual,
        id: item.id,
        rationale: item.comment ?? item.summary,
        severity: severityForFolio(item.severity),
        status: "pending",
        topic: item.area,
      },
    ];
  });

type ResolveFolioReviewFocusIdOptions = {
  focusedId: string | null;
  nativeSuggestionIds: ReadonlySet<string>;
  suggestions: readonly ReviewSuggestion[];
};

/**
 * The review store owns the persisted suggestion row id, whereas Folio owns
 * the client operation id used to stage its native suggestions. Reconciliation
 * deliberately renames only the former, so adapt the focus id at the renderer
 * boundary instead of leaking Folio's identity into persistence/navigation.
 *
 * When native staging is unavailable, the fallback decoration uses the row id
 * produced by `buildFolioReviewDecorations`; keep that path focused too.
 */
export const resolveFolioReviewFocusId = ({
  focusedId,
  nativeSuggestionIds,
  suggestions,
}: ResolveFolioReviewFocusIdOptions): string | null => {
  if (focusedId === null) {
    return null;
  }
  const focusedSuggestion = suggestions.find(
    (suggestion) => suggestion.id === focusedId,
  );
  const operationId = focusedSuggestion?.pendingOperation?.id;
  if (operationId !== undefined && nativeSuggestionIds.has(operationId)) {
    return operationId;
  }
  return focusedId;
};

export const findFolioReviewDecoration = (
  item: ReviewSuggestion,
  doc: ProseMirrorNode,
): AISuggestion | null =>
  buildFolioReviewDecorations([item], doc).at(0) ?? null;
