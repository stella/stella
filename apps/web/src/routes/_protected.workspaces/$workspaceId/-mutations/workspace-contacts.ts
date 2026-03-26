import { useMutation } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { PartyRole } from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import { workspaceContactsKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-contacts";

type AddPartyVars = {
  workspaceId: string;
  contactId: string;
  role: PartyRole;
  isPrimary?: boolean;
  notes?: string | null;
};

export const useAddParty = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: AddPartyVars) => {
      const response = await api.workspaces({ workspaceId }).contacts.put({
        ...body,
        queryKey: workspaceContactsKeys.all(workspaceId),
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

type RemovePartyVars = {
  workspaceId: string;
  workspaceContactId: string;
};

export const useRemoveParty = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({
      workspaceId,
      workspaceContactId,
    }: RemovePartyVars) => {
      const response = await api
        .workspaces({ workspaceId })
        .contacts({ workspaceContactId })
        .delete({
          queryKey: workspaceContactsKeys.all(workspaceId),
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
