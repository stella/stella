import {
  type RefetchQueryFilters,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { panic } from "better-result";

import { getTranslator } from "@/i18n/translator";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import {
  shouldRetryAPIRequest,
  toAPIError,
  unwrapApiResponse,
} from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { createUuid } from "@/lib/uuid";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { useTableStore } from "@/lib/workspaces/table-store";

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
      const id = createUuid();
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
      analytics.captureError(error, {
        fingerprintKey: "useCreateWorkspace:failure",
        scope: { type: "handler", handlerId: "useCreateWorkspace:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};

type WorkspaceUpdateValueByType = {
  color: string | null;
  leadUserId: string | null;
  name: string;
  reference: string;
};

type WorkspaceUpdateType = keyof WorkspaceUpdateValueByType;

export type WorkspaceUpdate =
  | { type: "clientId"; value: string; expectedClientId: string | null }
  | {
      [Type in WorkspaceUpdateType]: {
        type: Type;
        value: WorkspaceUpdateValueByType[Type];
      };
    }[WorkspaceUpdateType];

type WorkspaceUpdateRefreshScope = "query-cache" | "route-metadata";

const WORKSPACE_UPDATE_REFRESH_SCOPE = {
  clientId: "query-cache",
  color: "query-cache",
  leadUserId: "query-cache",
  name: "route-metadata",
  reference: "query-cache",
} as const satisfies Record<
  WorkspaceUpdate["type"],
  WorkspaceUpdateRefreshScope
>;

type UpdateWorkspaceVars = {
  workspaceId: string;
  update: WorkspaceUpdate;
};

export const workspaceUpdateRefreshScope = (update: WorkspaceUpdate) =>
  WORKSPACE_UPDATE_REFRESH_SCOPE[update.type];

export const workspaceUpdateBody = (update: WorkspaceUpdate) => {
  switch (update.type) {
    case "clientId":
      return {
        clientId: toSafeId<"contact">(update.value),
        expectedClientId:
          update.expectedClientId === null
            ? null
            : toSafeId<"contact">(update.expectedClientId),
      };
    case "color":
      return { color: update.value };
    case "leadUserId":
      return { leadUserId: update.value };
    case "name":
      return { name: update.value };
    case "reference":
      return { reference: update.value };
    default: {
      update satisfies never;
      return panic(`Unhandled update: ${String(update)}`);
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
      if (workspaceUpdateRefreshScope(variables.update) === "route-metadata") {
        await router.invalidate();
      }
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useUpdateWorkspace:failure",
        scope: { type: "handler", handlerId: "useUpdateWorkspace:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
      analytics.captureError(error, {
        fingerprintKey: "useUnarchiveWorkspace:failure",
        scope: { type: "handler", handlerId: "useUnarchiveWorkspace:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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
    onSuccess: (_data, { workspaceId }) => {
      useTableStore.getState().dropMatter(workspaceId);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDeleteWorkspace:failure",
        scope: { type: "handler", handlerId: "useDeleteWorkspace:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
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

      return unwrapApiResponse(response);
    },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
        "workspaces-mutations.invalidate",
      );
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useDuplicateWorkspace:failure",
        scope: { type: "handler", handlerId: "useDuplicateWorkspace:failure" },
      });
      notifyUserError(error, getTranslator()("errors.actionFailed"));
    },
  });
};
