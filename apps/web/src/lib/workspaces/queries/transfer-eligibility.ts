import { queryOptions, useQuery } from "@tanstack/react-query";

import { mapWithConcurrency } from "@stll/concurrency";
import { chunk } from "@stll/concurrency/chunk";

import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  entitiesKeys,
} from "@/lib/workspaces/queries/entities.logic";
import { areEntityTransfersAvailable } from "@/lib/workspaces/queries/transfer-eligibility.logic";

type TransferEligibilityOptions = {
  workspaceId: string;
  userId: string;
  organizationId: string;
  entityIds: readonly string[];
};

const TRANSFER_ELIGIBILITY_CONCURRENCY = 2;

export const transferEligibilityOptions = ({
  workspaceId,
  userId,
  organizationId,
  entityIds,
}: TransferEligibilityOptions) => {
  const ids = [...new Set(entityIds)].toSorted();
  return queryOptions({
    queryKey: [
      ...entitiesKeys.all(workspaceId),
      "transfer-eligibility",
      { userId, organizationId },
      ids,
    ],
    queryFn: async ({ signal }) => {
      const matter = { workspaceId: toSafeId<"workspace">(workspaceId) };
      const request = api.entities(matter)["transfer-eligibility"].post;
      const results = await mapWithConcurrency({
        items: chunk(ids, DEFAULT_ENTITY_WINDOW_SIZE),
        limit: TRANSFER_ELIGIBILITY_CONCURRENCY,
        operation: async (batch) =>
          unwrapEden(
            await request(
              { entityIds: batch.map((id) => toSafeId<"entity">(id)) },
              { fetch: { signal } },
            ),
          ),
      });
      return { transfers: results.flatMap(({ transfers }) => transfers) };
    },
  });
};

type UseTransferEligibilityOptions = {
  workspaceId: string;
  entityIds: readonly string[];
  enabled: boolean;
};

export const useTransferEligibility = ({
  workspaceId,
  entityIds,
  enabled,
}: UseTransferEligibilityOptions) => {
  const user = useAuthenticatedUser();
  const query = useQuery({
    ...transferEligibilityOptions({
      workspaceId,
      entityIds,
      userId: user.id,
      organizationId: user.activeOrganizationId,
    }),
    enabled: enabled && entityIds.length > 0,
  });
  const view = useQueryView(query);
  useQueryViewError(view);
  return (
    enabled &&
    !query.isFetching &&
    !query.isError &&
    view.type === "items" &&
    areEntityTransfersAvailable({ entityIds, transfers: view.items.transfers })
  );
};
