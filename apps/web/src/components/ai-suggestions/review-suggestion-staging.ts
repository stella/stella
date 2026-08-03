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
};

type StageReviewSuggestionsOptions = {
  editor: ReviewSuggestionStagingEditor;
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
  editor,
  suggestions,
  updateSuggestion,
}: StageReviewSuggestionsOptions): void => {
  const alreadyStaged = new Set(
    editor.getSuggestions().map((suggestion) => suggestion.suggestionId),
  );
  const groups = new Map<FolioAIEditSnapshot, ReviewSuggestion[]>();
  for (const item of suggestions) {
    const operation = item.pendingOperation;
    const snapshot = item.snapshot;
    if (
      item.status !== "pending" ||
      operation === null ||
      snapshot === null ||
      alreadyStaged.has(operation.id)
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
      updateSuggestion(item.id, {
        revisionIds: applied.revisionIds ?? null,
        undoHandle: result.undoHandle,
      });
    }
  }
};
