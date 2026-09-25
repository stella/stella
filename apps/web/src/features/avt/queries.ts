import { queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { VerificationRunStatus } from "@/features/avt/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const RUN_POLL_INTERVAL_MS = 2500;

/** Poll while the run is still waiting or checking; stop once it settles. */
const runPollInterval = (
  status: VerificationRunStatus | undefined,
): number | false => {
  switch (status) {
    case "queued":
    case "running": {
      return RUN_POLL_INTERVAL_MS;
    }
    case "completed":
    case "failed":
    case undefined: {
      return false;
    }
    default: {
      status satisfies never;
      return panic(`Unhandled verification status: ${String(status)}`);
    }
  }
};

/** One file of one document: a verification belongs to a file field. */
export type DocumentFile = {
  entityId: string;
  fileFieldId: string;
};

/** Lookup key of a document file in the latest-verification map. */
export const documentFileKey = ({ entityId, fileFieldId }: DocumentFile) =>
  `${entityId}:${fileFieldId}`;

type LatestVerificationsKey = {
  workspaceId: string;
  documents: readonly DocumentFile[];
};

export const avtKeys = {
  all: (workspaceId: string) => ["avt", workspaceId] as const,
  run: (workspaceId: string, runId: string) =>
    [...avtKeys.all(workspaceId), "run", runId] as const,
  latestAll: (workspaceId: string) =>
    [...avtKeys.all(workspaceId), "latest"] as const,
  latest: ({ workspaceId, documents }: LatestVerificationsKey) =>
    [
      ...avtKeys.latestAll(workspaceId),
      documents.map(documentFileKey).toSorted(),
    ] as const,
};

/** Documents per latest-verification request, the endpoint's cap. */
const LATEST_READ_CHUNK = 200;

export const verificationRunOptions = (workspaceId: string, runId: string) =>
  queryOptions({
    queryKey: avtKeys.run(workspaceId, runId),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .verifications({ runId: toSafeId<"legalListVerificationRun">(runId) })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    // Kept polling while the tab is hidden, so a reviewer who starts a run
    // and switches away comes back to the claims that landed meanwhile.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => runPollInterval(query.state.data?.status),
  });

/**
 * The latest verification of each document, one request per 200 documents
 * rather than one per document. Polls while any of them is still running.
 */
export const latestVerificationsOptions = (key: LatestVerificationsKey) =>
  queryOptions({
    queryKey: avtKeys.latest(key),
    queryFn: async ({ signal }) => {
      const chunks: DocumentFile[][] = [];
      for (
        let start = 0;
        start < key.documents.length;
        start += LATEST_READ_CHUNK
      ) {
        chunks.push(key.documents.slice(start, start + LATEST_READ_CHUNK));
      }
      const pages = await Promise.all(
        chunks.map(async (documents) =>
          unwrapEden(
            await api
              .lists({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
              .verifications.latest.post(
                {
                  documents: documents.map((doc) => ({
                    entityId: toSafeId<"entity">(doc.entityId),
                    fileFieldId: toSafeId<"field">(doc.fileFieldId),
                  })),
                },
                { fetch: { signal } },
              ),
          ),
        ),
      );
      return new Map(
        pages
          .flatMap((page) => page.runs)
          .map((run) => [documentFileKey(run), run]),
      );
    },
    enabled: key.documents.length > 0,
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (runs === undefined) {
        return false;
      }
      for (const run of runs.values()) {
        if (runPollInterval(run.status) !== false) {
          return runPollInterval(run.status);
        }
      }
      return false;
    },
  });
