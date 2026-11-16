import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import {
  knowledgeKeys,
  playbooksOptions,
  playbookStartersOptions,
  recentPlaybooksOptions,
} from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

type StarterId = Parameters<
  (typeof api.playbooks)["from-starter"]["post"]
>[0]["starterId"];

const PLAYBOOKS_PAGE_LIMIT = 50;

/** The first page of the organization's playbooks. */
const usePlaybooks = (organizationId: string) =>
  useQuery({
    ...playbooksOptions(organizationId),
    refetchOnWindowFocus: false,
  });

/** The organization's recently used playbooks. */
const useRecentPlaybooks = (organizationId: string) => {
  const { id: userId } = useAuthenticatedUser();
  const dataQuery = useQuery({
    ...recentPlaybooksOptions(organizationId, userId),
    refetchOnWindowFocus: false,
  });
  const { isLoading } = dataQuery;
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "useRecentPlaybooks:query");
  const data = dataView.type === "items" ? dataView.items : undefined;
  return {
    status: isLoading ? ("loading" as const) : ("ready" as const),
    items: data ? data.items : [],
  };
};

/** The ready-made playbooks, read only where they are offered. */
const usePlaybookStarters = (organizationId: string, enabled: boolean) => {
  const dataQuery = useQuery({
    ...playbookStartersOptions(organizationId),
    enabled,
  });
  const { isLoading } = dataQuery;
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "usePlaybookStarters:query");
  const data = dataView.type === "items" ? dataView.items : undefined;
  return {
    status: isLoading ? ("loading" as const) : ("ready" as const),
    items: data ? data.items : [],
  };
};

/** Reads of the organization's playbooks. */
export const memberPlaybooksSource = {
  usePlaybooks,
  useRecentPlaybooks,
  usePlaybookStarters,
};

/**
 * The organization's playbook calls, unchanged from the ones the page made
 * before; each returns the API response so the caller keeps its own handling.
 */
const usePlaybookActions = (organizationId: string) => {
  const submit = useIdempotentSubmit();
  const queryClient = useQueryClient();

  return {
    invalidatePlaybooks: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.playbooks.all(organizationId),
        }),
        "knowledge-playbooks.invalidate",
      );
    },
    loadPage: async (cursor: string, signal: AbortSignal) =>
      api.playbooks.get({
        query: { cursor, limit: PLAYBOOKS_PAGE_LIMIT },
        fetch: { signal },
      }),
    createFromStarter: async (starterId: StarterId) =>
      unwrapApiResponse(
        await submit.run({
          operation: "playbook-from-starter",
          body: { starterId },
          send: async (creationPayload) =>
            api.playbooks["from-starter"].post(creationPayload),
        }),
      ),
  };
};

/** Writes to the organization's playbooks. */
export const memberPlaybooksActions = {
  usePlaybookActions,
};
