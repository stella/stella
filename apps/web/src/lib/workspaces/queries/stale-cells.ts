import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities.logic";

/**
 * The documents and columns whose AI values a new document version left
 * stale. Keyed under the matter's entities, so every refresh of the cells (an
 * upload, a run finishing, a live update) refreshes it too.
 */
export const staleCellsOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: [...entitiesKeys.all(workspaceId), "stale-cells"],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .workflow.stale.get({ fetch: { signal } }),
      ),
  });
