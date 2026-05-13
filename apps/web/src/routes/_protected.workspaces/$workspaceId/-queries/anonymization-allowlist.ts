import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

export type AnonymizationAllowlistKey = {
  workspaceId: string;
  entityId: string | null;
};

export const anonymizationAllowlistKeys = {
  all: ({ workspaceId, entityId }: AnonymizationAllowlistKey): string[] => [
    "anonymization-allowlist",
    workspaceId,
    entityId ?? "no-entity",
  ],
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
