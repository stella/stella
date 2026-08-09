import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import {
  anonymizationAllowlistQueryRoot,
  workspaceAnonymizationAllowlistQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";

export type AnonymizationAllowlistKey = {
  workspaceId: string;
  entityId: string | null;
};

export const anonymizationAllowlistKeys = {
  root: anonymizationAllowlistQueryRoot(),
  all: ({ workspaceId, entityId }: AnonymizationAllowlistKey): string[] => [
    ...anonymizationAllowlistKeys.root,
    workspaceId,
    entityId ?? "no-entity",
  ],
  /**
   * Broader prefix matching every doc's allowlist query in this
   * workspace. Use this as the SSE invalidation key when a
   * workspace- or org-scoped entry changes, so allowlists for
   * other open documents refresh too — entity-keyed queries
   * would otherwise keep stale exclusions.
   */
  workspace: workspaceAnonymizationAllowlistQueryRoot,
};

export const anonymizationAllowlistOptions = ({
  workspaceId,
  entityId,
}: AnonymizationAllowlistKey) =>
  queryOptions({
    queryKey: anonymizationAllowlistKeys.all({ workspaceId, entityId }),
    queryFn: async ({ signal }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-allowlist"].get({
          fetch: { signal },
          ...(entityId
            ? { query: { entityId: toSafeId<"entity">(entityId) } }
            : {}),
        });

      return unwrapEden(response);
    },
  });
