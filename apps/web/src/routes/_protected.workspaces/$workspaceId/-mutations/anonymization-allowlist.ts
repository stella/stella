import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { anonymizationAllowlistKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-allowlist";

export type AllowlistScope = "document" | "workspace" | "organization";

type CreateAllowlistEntryVars = {
  workspaceId: string;
  entityId: string | null;
  canonical: string;
  label: string;
  scope: AllowlistScope;
};

export const useCreateAnonymizationAllowlistEntry = () => {
  const analytics = useAnalytics();
  return useMutation({
    mutationFn: async ({
      workspaceId,
      entityId,
      canonical,
      label,
      scope,
    }: CreateAllowlistEntryVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-allowlist"].put({
          canonical,
          label,
          scope,
          ...(scope === "document" && entityId
            ? { entityId: toSafeId<"entity">(entityId) }
            : {}),
          queryKey: anonymizationAllowlistKeys.all({ workspaceId, entityId }),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DeleteAllowlistEntryVars = {
  workspaceId: string;
  entityId: string | null;
  entryId: string;
};

export const useDeleteAnonymizationAllowlistEntry = () => {
  const analytics = useAnalytics();
  return useMutation({
    mutationFn: async ({
      workspaceId,
      entityId,
      entryId,
    }: DeleteAllowlistEntryVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-allowlist"]({
          entryId: toSafeId<"anonymizationAllowlistEntry">(entryId),
        })
        .delete({
          queryKey: anonymizationAllowlistKeys.all({ workspaceId, entityId }),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
