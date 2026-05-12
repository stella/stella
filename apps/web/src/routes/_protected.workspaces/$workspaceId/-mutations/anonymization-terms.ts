import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { anonymizationTermsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/anonymization-terms";

type CreateTermsVars = {
  workspaceId: string;
  entries: readonly {
    canonical: string;
    label: string;
    variants?: readonly string[];
  }[];
};

export const useCreateAnonymizationTerms = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, entries }: CreateTermsVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-terms"].put({
          entries: entries.map((entry) =>
            entry.variants
              ? {
                  canonical: entry.canonical,
                  label: entry.label,
                  variants: [...entry.variants],
                }
              : {
                  canonical: entry.canonical,
                  label: entry.label,
                },
          ),
          queryKey: anonymizationTermsKeys.all(workspaceId),
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

type DeleteTermVars = {
  workspaceId: string;
  entryId: string;
};

export const useDeleteAnonymizationTerm = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, entryId }: DeleteTermVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["anonymization-terms"]({
          entryId: toSafeId<"anonymizationBlacklistEntry">(entryId),
        })
        .delete({
          queryKey: anonymizationTermsKeys.all(workspaceId),
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
