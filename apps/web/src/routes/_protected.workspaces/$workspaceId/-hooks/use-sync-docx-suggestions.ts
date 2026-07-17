/**
 * useSyncDocxSuggestions — hydrate the in-memory review store from the
 * persisted DOCX suggestions on reload.
 *
 * Mirrors `use-sync-justifications`: run the list query, then in a sync
 * effect reconstruct each `ReviewSuggestion` from its stored `opPayload`
 * (reusing the same builders the live queue path uses) and merge into
 * the store. The store dedups by id, so re-running as the data settles
 * (or as the editor snapshot becomes ready) can't create duplicates and
 * never forces the review panel open.
 */

import type { RefObject } from "react";

import { useQuery } from "@tanstack/react-query";

import type { DocxEditorRef, FolioAIEditOperation } from "@stll/folio-react";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import {
  buildPreview,
  folioOperationBlockId,
  folioOperationComment,
  summarizeOperation,
} from "@/components/ai-suggestions/review-suggestion-builder";
import type { SnapshotBlock } from "@/components/ai-suggestions/review-suggestion-builder";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { docxSuggestionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/docx-suggestions";

type UseSyncDocxSuggestionsInput = {
  workspaceId: string;
  entityId: string;
  editorRef: RefObject<DocxEditorRef | null>;
};

export const useSyncDocxSuggestions = ({
  workspaceId,
  entityId,
  editorRef,
}: UseSyncDocxSuggestionsInput) => {
  const { data } = useQuery(docxSuggestionsOptions({ workspaceId, entityId }));

  useExternalSyncEffect(() => {
    if (!data) {
      return;
    }

    // Rebuild each preview against the live editor snapshot (the same
    // source the queue path uses). If the editor isn't ready yet the
    // snapshot is null and previews degrade to block-less shapes;
    // buildPreview returns null for the ops that can't render without a
    // block, and those rows are skipped until a later data change re-runs
    // this effect with a ready editor.
    const snapshot = editorRef.current?.createAIEditSnapshot() ?? null;
    const blocksById = new Map<string, SnapshotBlock>(
      (snapshot?.blocks ?? []).map((block) => [block.id, block]),
    );

    const items = data.items.flatMap((row): ReviewSuggestion[] => {
      // SAFETY: `opPayload` is stored opaquely (`t.Unknown()`) but was
      // persisted from a client-prepared folio operation by the create
      // handler, so it round-trips back as a FolioAIEditOperation. Narrow
      // it here at the hydration boundary.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see the SAFETY note above; the op was persisted from a client-prepared FolioAIEditOperation and passes back opaquely through the jsonb column
      const op = row.opPayload as FolioAIEditOperation;
      const preview = buildPreview(op, blocksById);
      if (preview === null) {
        return [];
      }

      const item: ReviewSuggestion = {
        id: row.id,
        blockId: folioOperationBlockId(op),
        type: op.type,
        summary: summarizeOperation(op),
        preview,
        severity: row.severity,
        area: row.area,
        status: row.status,
        applyMode: row.appliedMode,
        revisionIds: null,
        undoHandle: null,
        pendingOperation: op,
        snapshot,
        persisted: true,
      };
      const comment = row.comment ?? folioOperationComment(op)?.text;
      if (comment !== undefined) {
        item.comment = comment;
      }
      return [item];
    });

    useReviewStore.getState().hydrateSuggestions(entityId, items);
  }, [data, editorRef, entityId]);
};
