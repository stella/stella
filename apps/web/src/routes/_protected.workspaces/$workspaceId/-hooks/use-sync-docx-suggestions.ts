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
import { useState } from "react";

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

// Editor-readiness poll cadence and bound: the list query can resolve before
// the editor mounts and populates its blocks, so we retry until a snapshot
// appears, then give up (~3s) rather than leaving a timer running forever.
const SNAPSHOT_POLL_INTERVAL_MS = 150;
const SNAPSHOT_POLL_MAX_ATTEMPTS = 20;

export const useSyncDocxSuggestions = ({
  workspaceId,
  entityId,
  editorRef,
}: UseSyncDocxSuggestionsInput) => {
  const { data } = useQuery(docxSuggestionsOptions({ workspaceId, entityId }));

  // Bumped once the editor snapshot becomes available, to re-run hydration
  // against a ready editor (see the poll effect below).
  const [snapshotReadyTick, setSnapshotReadyTick] = useState(0);

  // Poll for editor readiness. If the query resolves first, the initial
  // hydration runs with a null snapshot: every op's block lookup misses, so
  // buildPreview returns null and nothing hydrates. Once
  // `createAIEditSnapshot()` returns non-null, bump the tick so hydration
  // re-runs against the ready editor. The store dedups by id, so the re-run
  // can't duplicate rows.
  useExternalSyncEffect(() => {
    if (!data) {
      return () => undefined;
    }
    if ((editorRef.current?.createAIEditSnapshot() ?? null) !== null) {
      return () => undefined;
    }

    let attempts = 0;
    const intervalId = window.setInterval(() => {
      attempts += 1;
      if ((editorRef.current?.createAIEditSnapshot() ?? null) !== null) {
        window.clearInterval(intervalId);
        setSnapshotReadyTick((tick) => tick + 1);
        return;
      }
      if (attempts >= SNAPSHOT_POLL_MAX_ATTEMPTS) {
        window.clearInterval(intervalId);
      }
    }, SNAPSHOT_POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
    // `editorRef` is a stable ref object (its identity never changes), so it
    // adds no re-runs; it satisfies the exhaustive-deps read of
    // `editorRef.current` inside the poll.
  }, [data, editorRef]);

  useExternalSyncEffect(() => {
    if (!data) {
      return;
    }

    // Rebuild each preview against the live editor snapshot (the same
    // source the queue path uses). If the editor isn't ready yet the
    // snapshot is null and buildPreview returns null for every
    // block-anchored op, so those rows are skipped; the readiness poll
    // above bumps `snapshotReadyTick` once a snapshot appears, re-running
    // this effect so the skipped rows hydrate against the ready editor.
    const snapshot = editorRef.current?.createAIEditSnapshot() ?? null;
    const snapshotBlocks = snapshot ? snapshot.blocks : [];
    const blocksById = new Map<string, SnapshotBlock>(
      snapshotBlocks.map((block) => [block.id, block]),
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
  }, [data, editorRef, entityId, snapshotReadyTick]);
};
