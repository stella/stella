import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

// Hardcoded in English: these are persisted in the DB and shared
// across all organization members regardless of their locale.
const DEFAULT_FILE_PROPERTY_NAME = "Documents";

type CreateWorkspaceVars = {
  // Omit `clientId` to create a personal matter (initially visible
  // only to the creator). With `clientId`, `memberUserIds` may add
  // other members; for personal matters that field is ignored.
  clientId?: string;
  memberUserIds?: string[];
  name: string;
};

export const useCreateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: CreateWorkspaceVars) => {
      const id = crypto.randomUUID();
      const response = await api.workspaces.put({
        queryKey: workspacesKeys.all,
        id: toSafeId<"workspace">(id),
        ...(vars.clientId !== undefined && {
          clientId: toSafeId<"contact">(vars.clientId),
          ...(vars.memberUserIds && vars.memberUserIds.length > 0
            ? { memberUserIds: vars.memberUserIds }
            : {}),
        }),
        name: vars.name,
        filePropertyName: DEFAULT_FILE_PROPERTY_NAME,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return { id: toSafeId<"workspace">(id) };
    },
    onSuccess: () => {
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
      });
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.navigation(),
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
  clientId?: string;
  reference?: string;
  color?: string | null;
  promote?: {
    clientId: string;
    memberUserIds?: string[];
  };
};

export const workspaceUpdateInvalidationKeys = (workspaceId: string) => [
  workspacesKeys.byId(workspaceId),
  workspacesKeys.navigation(),
  workspacesKeys.all,
];

export const useUpdateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId, ...body }: UpdateWorkspaceVars) => {
      const { clientId, promote, ...restBody } = body;
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .post({
          ...restBody,
          ...(clientId !== undefined && {
            clientId: toSafeId<"contact">(clientId),
          }),
          ...(promote !== undefined && {
            promote: {
              clientId: toSafeId<"contact">(promote.clientId),
              ...(promote.memberUserIds && promote.memberUserIds.length > 0
                ? { memberUserIds: promote.memberUserIds }
                : {}),
            },
          }),
          queryKey: workspacesKeys.all,
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: (_data, variables) => {
      for (const queryKey of workspaceUpdateInvalidationKeys(
        variables.workspaceId,
      )) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type ArchiveWorkspaceVars = {
  workspaceId: string;
};

export const useArchiveWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId }: ArchiveWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .archive.post({
          queryKey: workspacesKeys.all,
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
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.navigation(),
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

export const useUnarchiveWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId }: ArchiveWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .unarchive.post({
          queryKey: workspacesKeys.all,
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
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.navigation(),
      });
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
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .delete({
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
