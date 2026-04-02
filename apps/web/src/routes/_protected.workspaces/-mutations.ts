import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

// Hardcoded in English: these are persisted in the DB and shared
// across all organization members regardless of their locale.
const DEFAULT_WORKSPACE_NAME = "Untitled";
const DEFAULT_FILE_PROPERTY_NAME = "Documents";

type CreateWorkspaceVars = {
  name?: string | undefined;
};

export const useCreateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars?: CreateWorkspaceVars) => {
      const response = await api.workspaces.put({
        queryKey: workspacesKeys.all,
        id: crypto.randomUUID(),
        name: vars?.name || DEFAULT_WORKSPACE_NAME,
        filePropertyName: DEFAULT_FILE_PROPERTY_NAME,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: () => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type UpdateWorkspaceVars = {
  workspaceId: string;
  name?: string;
  clientId?: string | null;
  reference?: string;
  color?: string | null;
};

export const useUpdateWorkspace = () => {
  const analytics = useAnalytics();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateWorkspaceVars) => {
      const response = await api.workspaces({ workspaceId }).post({
        ...body,
        queryKey: workspacesKeys.all,
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

type DeleteWorkspaceVars = {
  workspaceId: string;
};

export const useDeleteWorkspace = () => {
  const analytics = useAnalytics();

  return useMutation({
    retry: (failureCount, error) =>
      failureCount < 3 && (!APIError.is(error) || error.status >= 500),
    mutationFn: async ({ workspaceId }: DeleteWorkspaceVars) => {
      const response = await api.workspaces({ workspaceId }).delete({
        queryKey: workspacesKeys.all,
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
