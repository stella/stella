import { queryOptions } from "@tanstack/react-query";

import {
  isTerminalFlowRunStatus,
  type FlowRunStatus,
} from "@/components/flows/flow-meta";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

// ── Key type ────────────────────────────────────────

type FlowRunsListKey = {
  workspaceId: string;
  limit: number;
  status: FlowRunStatus | null;
};

const FLOW_RUNS_PAGE_SIZE = 50;
const FLOW_RUNS_POLL_MS = 3000;

// ── Key helpers ─────────────────────────────────────

export const flowRunsKeys = {
  all: (workspaceId: string) => ["flow-runs", workspaceId],
  list: (key: FlowRunsListKey) => [
    ...flowRunsKeys.all(key.workspaceId),
    "list",
    { limit: key.limit, status: key.status },
  ],
  detail: (workspaceId: string, runId: string) => [
    ...flowRunsKeys.all(workspaceId),
    runId,
    "detail",
  ],
};

// ── Options ─────────────────────────────────────────

type FlowRunsOptionsInput = {
  workspaceId: string;
  limit?: number;
  status?: FlowRunStatus;
};

export const flowRunsOptions = ({
  workspaceId,
  limit = FLOW_RUNS_PAGE_SIZE,
  status,
}: FlowRunsOptionsInput) =>
  queryOptions({
    queryKey: flowRunsKeys.list({
      workspaceId,
      limit,
      status: status ?? null,
    }),
    queryFn: async ({ signal }) => {
      const query: { limit: number; status?: FlowRunStatus } = { limit };
      if (status) {
        query.status = status;
      }
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .flows.runs.get({ query, fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    // Poll while any listed run is still active; the function form returns
    // `false` once everything is terminal so the interval clears itself.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !("items" in data)) {
        return false;
      }
      const hasActive = data.items.some(
        (run) => !isTerminalFlowRunStatus(run.status),
      );
      return hasActive ? FLOW_RUNS_POLL_MS : false;
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

export const flowRunDetailOptions = (workspaceId: string, runId: string) =>
  queryOptions({
    queryKey: flowRunsKeys.detail(workspaceId, runId),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .flows.runs({ runId: toSafeId<"flowRun">(runId) })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !("status" in data)) {
        return false;
      }
      return isTerminalFlowRunStatus(data.status) ? false : FLOW_RUNS_POLL_MS;
    },
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
