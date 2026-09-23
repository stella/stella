import { queryOptions } from "@tanstack/react-query";

import type { VerificationRunStatus } from "@/features/avt/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

const RUN_POLL_INTERVAL_MS = 2500;

/** Poll while the run is still waiting or checking; stop once it settles. */
export const runPollInterval = (
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
      return false;
    }
  }
};

type DocumentKey = {
  workspaceId: string;
  entityId: string;
  fileFieldId: string;
};

export const avtKeys = {
  all: (workspaceId: string) => ["avt", workspaceId] as const,
  run: (workspaceId: string, runId: string) =>
    [...avtKeys.all(workspaceId), "run", runId] as const,
  documentRuns: ({ workspaceId, entityId, fileFieldId }: DocumentKey) =>
    [...avtKeys.all(workspaceId), "document", entityId, fileFieldId] as const,
};

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

/** The document's latest verification; its history stays in the API. */
export const latestDocumentVerificationOptions = (key: DocumentKey) =>
  queryOptions({
    queryKey: avtKeys.documentRuns(key),
    queryFn: async ({ signal }) => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(key.workspaceId) })
        .verifications.get({
          query: {
            entityId: toSafeId<"entity">(key.entityId),
            fileFieldId: toSafeId<"field">(key.fileFieldId),
            limit: 1,
          },
          fetch: { signal },
        });
      return unwrapEden(response).items.at(0) ?? null;
    },
    refetchInterval: (query) => runPollInterval(query.state.data?.status),
  });
