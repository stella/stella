import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { organizationAnonymizationBlacklistKeys } from "@/routes/_protected.settings/-queries/anonymization-blacklist";

export type OrgAnonymizationBlacklistEntry = {
  canonical: string;
  label: string;
  variants?: readonly string[];
  enabled?: boolean;
};

type UpdateBlacklistVars = {
  entries: readonly OrgAnonymizationBlacklistEntry[];
};

/**
 * Replace the org-wide deny list. Endpoint performs a full
 * upsert: rows missing from the request are deleted, present
 * rows are upserted (keyed on lowercased canonical). Callers
 * therefore submit the full target list, not a delta.
 */
export const useUpdateOrganizationAnonymizationBlacklist = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ entries }: UpdateBlacklistVars) => {
      const response = await api["organization-settings"][
        "anonymization-blacklist"
      ].put({
        entries: entries.map((entry) => ({
          canonical: entry.canonical,
          label: entry.label,
          ...(entry.variants ? { variants: [...entry.variants] } : {}),
          ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        })),
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationAnonymizationBlacklistKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
