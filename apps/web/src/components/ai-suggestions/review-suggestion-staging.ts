import type { DocxEditorRef, FolioAIEditSnapshot } from "@stll/folio-react";

import type { ReviewSuggestion } from "./review-store";

const DOCUMENT_OPERATION_CONTRACT_VERSION = 1 as const;

type ReviewSuggestionStagingEditor = {
  applyDocumentOperations: (
    options: Parameters<DocxEditorRef["applyDocumentOperations"]>[0],
  ) => Pick<
    ReturnType<DocxEditorRef["applyDocumentOperations"]>,
    "applied" | "undoHandle"
  >;
  getSuggestions: DocxEditorRef["getSuggestions"];
  rejectSuggestion: DocxEditorRef["rejectSuggestion"];
};

type StageReviewSuggestionsOptions = {
  canStage: boolean;
  editor: ReviewSuggestionStagingEditor;
  managedSuggestionIds: Set<string>;
  suggestions: readonly ReviewSuggestion[];
  updateSuggestion: (
    id: string,
    patch: Pick<ReviewSuggestion, "revisionIds" | "undoHandle">,
  ) => void;
};

/**
 * Put pending proposals into Folio's native `suggested` mode. These changes
 * participate in real layout and pagination, but Folio excludes them from a
 * serialized DOCX until the reviewer accepts them.
 */
export const stageReviewSuggestions = ({
  canStage,
  editor,
  managedSuggestionIds,
  suggestions,
  updateSuggestion,
}: StageReviewSuggestionsOptions): void => {
  const liveSuggestionIds = new Set(
    editor.getSuggestions().map((suggestion) => suggestion.suggestionId),
  );
  const desiredSuggestionIds = new Set(
    suggestions.flatMap((suggestion) =>
      suggestion.status === "pending" && suggestion.pendingOperation !== null
        ? [suggestion.pendingOperation.id]
        : [],
    ),
  );

  // The editor outlives a review-session reset. Remove only suggestions this
  // bridge previously staged; unrelated user-authored Folio suggestions must
  // remain untouched.
  for (const suggestionId of managedSuggestionIds) {
    if (desiredSuggestionIds.has(suggestionId)) {
      continue;
    }
    if (
      !liveSuggestionIds.has(suggestionId) ||
      editor.rejectSuggestion(suggestionId)
    ) {
      managedSuggestionIds.delete(suggestionId);
      liveSuggestionIds.delete(suggestionId);
    }
  }

  // Reclaim matching suggestions after an effect restart without claiming
  // any native suggestion that is absent from the active review session.
  for (const suggestionId of desiredSuggestionIds) {
    if (liveSuggestionIds.has(suggestionId)) {
      managedSuggestionIds.add(suggestionId);
    }
  }

  if (!canStage) {
    return;
  }

  const groups = new Map<FolioAIEditSnapshot, ReviewSuggestion[]>();
  for (const item of suggestions) {
    const operation = item.pendingOperation;
    const snapshot = item.snapshot;
    if (
      item.status !== "pending" ||
      operation === null ||
      snapshot === null ||
      liveSuggestionIds.has(operation.id)
    ) {
      continue;
    }
    const group = groups.get(snapshot);
    if (group === undefined) {
      groups.set(snapshot, [item]);
    } else {
      group.push(item);
    }
  }

  for (const [snapshot, items] of groups) {
    const result = editor.applyDocumentOperations({
      snapshot,
      batch: {
        version: DOCUMENT_OPERATION_CONTRACT_VERSION,
        mode: "suggested",
        operations: items.flatMap((item) =>
          item.pendingOperation === null
            ? []
            : [
                {
                  ...item.pendingOperation,
                  suggestionId: item.pendingOperation.id,
                },
              ],
        ),
      },
    });
    for (const applied of result.applied) {
      const item = items.find(
        (candidate) => candidate.pendingOperation?.id === applied.id,
      );
      if (item === undefined) {
        continue;
      }
      const suggestionId = item.pendingOperation?.id;
      if (suggestionId !== undefined) {
        managedSuggestionIds.add(suggestionId);
      }
      updateSuggestion(item.id, {
        revisionIds: applied.revisionIds ?? null,
        undoHandle: result.undoHandle,
      });
    }
  }
};
