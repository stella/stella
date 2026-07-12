import { useCallback, useMemo, useRef } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { WorkspaceJustification } from "@/lib/types";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const normalizeEntityIds = (entityIds: readonly string[]) =>
  [...new Set(entityIds)].toSorted();

const JUSTIFICATION_ENTITY_IDS_CHUNK_SIZE = 200;

export const chunkJustificationEntityIds = (
  entityIds: readonly string[],
): string[][] => {
  const normalizedEntityIds = normalizeEntityIds(entityIds);
  const chunks: string[][] = [];

  for (
    let startIndex = 0;
    startIndex < normalizedEntityIds.length;
    startIndex += JUSTIFICATION_ENTITY_IDS_CHUNK_SIZE
  ) {
    chunks.push(
      normalizedEntityIds.slice(
        startIndex,
        startIndex + JUSTIFICATION_ENTITY_IDS_CHUNK_SIZE,
      ),
    );
  }

  return chunks;
};

type UseSyncJustificationsInput = {
  workspaceId: string;
  entityIds: readonly string[];
};

export const useSyncJustifications = (
  { workspaceId, entityIds }: UseSyncJustificationsInput,
  { enabled = true }: { enabled?: boolean } = {},
) => {
  const syncJustifications = useWorkspaceStore(
    (state) => state.syncJustifications,
  );
  const normalizedEntityIds = normalizeEntityIds(entityIds);

  const { data } = useQuery({
    ...justificationsOptions({
      workspaceId,
      entityIds: normalizedEntityIds,
    }),
    enabled: enabled && normalizedEntityIds.length > 0,
  });

  useExternalSyncEffect(() => {
    if (!data) {
      return;
    }

    syncJustifications(data);
  }, [data, syncJustifications]);
};

type UseSyncJustificationChunksInput = {
  workspaceId: string;
  entityIdChunks: readonly (readonly string[])[];
};

export const useSyncJustificationChunks = (
  { workspaceId, entityIdChunks }: UseSyncJustificationChunksInput,
  { enabled = true }: { enabled?: boolean } = {},
) => {
  const syncJustifications = useWorkspaceStore(
    (state) => state.syncJustifications,
  );
  const syncedResultsRef = useRef<Set<string> | null>(null);
  syncedResultsRef.current ??= new Set<string>();
  const normalizedChunks = useMemo(
    () =>
      entityIdChunks.flatMap((entityIds) => {
        const normalized = normalizeEntityIds(entityIds);
        return normalized.length > 0 ? [normalized] : [];
      }),
    [entityIdChunks],
  );
  const queries = useMemo(
    () =>
      normalizedChunks.map((entityIds) => ({
        ...justificationsOptions({
          workspaceId,
          entityIds,
        }),
        enabled,
      })),
    [normalizedChunks, workspaceId, enabled],
  );
  // useQueries memoizes on the `combine` identity, so it must be stable:
  // a fresh function each render makes `syncedResults` a new array every
  // render, which would re-fire the store-sync effect below in a loop.
  const combineResults = useCallback(
    (
      results: {
        data: WorkspaceJustification[] | undefined;
        dataUpdatedAt: number;
      }[],
    ) =>
      results.map((result, index) => {
        const entityIds = normalizedChunks.at(index);
        if (!entityIds) {
          panic(`Missing justification chunk at index ${index}`);
        }
        return {
          data: result.data,
          dataUpdatedAt: result.dataUpdatedAt,
          entityIds,
        };
      }),
    [normalizedChunks],
  );

  const syncedResults = useQueries({
    queries,
    combine: combineResults,
  });

  useExternalSyncEffect(() => {
    const syncedKeys = syncedResultsRef.current;
    if (!syncedKeys) {
      return;
    }

    for (const result of syncedResults) {
      if (!result.data || result.entityIds.length === 0) {
        continue;
      }

      const syncKey = [
        workspaceId,
        result.dataUpdatedAt,
        result.entityIds.join(","),
      ].join(":");
      if (syncedKeys.has(syncKey)) {
        continue;
      }

      syncedKeys.add(syncKey);
      syncJustifications(result.data);
    }
  }, [syncJustifications, syncedResults, workspaceId]);
};
