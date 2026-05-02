import { useCallback, useEffect, useMemo, useRef } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";

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
  const normalizedEntityIds = useMemo(
    () => normalizeEntityIds(entityIds),
    [entityIds],
  );

  const { data } = useQuery({
    ...justificationsOptions({
      workspaceId,
      entityIds: normalizedEntityIds,
    }),
    enabled: enabled && normalizedEntityIds.length > 0,
  });

  useEffect(() => {
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
  const syncedResultsRef = useRef(new Set<string>());
  const normalizedChunks = useMemo(
    () =>
      entityIdChunks
        .map((entityIds) => normalizeEntityIds(entityIds))
        .filter((entityIds) => entityIds.length > 0),
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
    [enabled, normalizedChunks, workspaceId],
  );
  const combineResults = useCallback(
    (
      results: {
        data: WorkspaceJustification[] | undefined;
        dataUpdatedAt: number;
      }[],
    ) =>
      results.map((result, index) => ({
        data: result.data,
        dataUpdatedAt: result.dataUpdatedAt,
        entityIds: normalizedChunks.at(index) ?? [],
      })),
    [normalizedChunks],
  );

  const syncedResults = useQueries({
    queries,
    combine: combineResults,
  });

  useEffect(() => {
    for (const result of syncedResults) {
      if (!result.data || result.entityIds.length === 0) {
        continue;
      }

      const syncKey = [
        workspaceId,
        result.dataUpdatedAt,
        result.entityIds.join(","),
      ].join(":");
      if (syncedResultsRef.current.has(syncKey)) {
        continue;
      }

      syncedResultsRef.current.add(syncKey);
      syncJustifications(result.data);
    }
  }, [syncJustifications, syncedResults, workspaceId]);
};
