import {
  type RefetchQueryFilters,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  shouldRetryAPIRequest,
  toAPIError,
  unwrapEden,
} from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";

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
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type WorkspaceUpdateValueByType = {
  clientId: string;
  color: string | null;
  leadUserId: string | null;
  name: string;
  promote: {
    clientId: string;
    memberUserIds?: string[];
  };
  reference: string;
};

type WorkspaceUpdateType = keyof WorkspaceUpdateValueByType;

export type WorkspaceUpdate = {
  [Type in WorkspaceUpdateType]: {
    type: Type;
    value: WorkspaceUpdateValueByType[Type];
  };
}[WorkspaceUpdateType];

type UpdateWorkspaceVars = {
  workspaceId: string;
  update: WorkspaceUpdate;
};

export const workspaceUpdateInvalidatesRoute = (update: WorkspaceUpdate) => {
  switch (update.type) {
    case "name":
      return true;
    case "clientId":
    case "color":
    case "leadUserId":
    case "promote":
    case "reference":
      return false;
    default: {
      const unreachable: never = update;
      return unreachable;
    }
  }
};

export const workspaceUpdateBody = (update: WorkspaceUpdate) => {
  switch (update.type) {
    case "clientId":
      return { clientId: toSafeId<"contact">(update.value) };
    case "color":
      return { color: update.value };
    case "leadUserId":
      return { leadUserId: update.value };
    case "name":
      return { name: update.value };
    case "promote":
      return {
        promote: {
          clientId: toSafeId<"contact">(update.value.clientId),
          ...(update.value.memberUserIds &&
            update.value.memberUserIds.length > 0 && {
              memberUserIds: update.value.memberUserIds,
            }),
        },
      };
    case "reference":
      return { reference: update.value };
    default: {
      const unreachable: never = update;
      return unreachable;
    }
  }
};

export const workspaceUpdateInvalidationKeys = () => [workspacesKeys.all];

export const workspaceUpdateRefetchFilters = (
  workspaceId: string,
): RefetchQueryFilters[] => [
  { queryKey: workspacesKeys.all, type: "active" },
  {
    exact: true,
    queryKey: workspacesKeys.byId(workspaceId),
    type: "inactive",
  },
];

export const useUpdateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async ({ update, workspaceId }: UpdateWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .post(workspaceUpdateBody(update));

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: async (_data, variables) => {
      const { workspaceId } = variables;
      await Promise.all(
        workspaceUpdateInvalidationKeys().map(async (queryKey) => {
          await queryClient.invalidateQueries({
            queryKey,
            refetchType: "none",
          });
        }),
      );
      await Promise.all(
        workspaceUpdateRefetchFilters(toSafeId<"workspace">(workspaceId)).map(
          async (filters) => {
            await queryClient.refetchQueries(filters);
          },
        ),
      );
      if (workspaceUpdateInvalidatesRoute(variables.update)) {
        await router.invalidate();
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

export const useUnarchiveWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId }: ArchiveWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .unarchive.post({});

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
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
    retry: shouldRetryAPIRequest,
    mutationFn: async ({ workspaceId }: DeleteWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .delete({});

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};

type DuplicateWorkspaceVars = {
  workspaceId: string;
  includeContent: boolean;
};

export const useDuplicateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      includeContent,
      workspaceId,
    }: DuplicateWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .duplicate.post({
          includeContent,
        });

      return unwrapEden(response);
    },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
        "workspaces-mutations.invalidate",
      );
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
};
