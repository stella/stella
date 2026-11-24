import {
  type RefetchQueryFilters,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { panic } from "better-result";

import type { MatterVisibility } from "@stll/api-contract/matter-visibility";
import { DEFAULT_FILE_PROPERTY_NAME } from "@stll/api-contract/property-policy";

import { getTranslator } from "@/i18n/translator";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import {
  shouldRetryAPIRequest,
  toAPIError,
  unwrapApiResponse,
} from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
import { toSafeId } from "@/lib/safe-id";
import { resourceMutation } from "@/lib/workspace-realtime";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { useTableStore } from "@/lib/workspaces/table-store";

type CreateWorkspaceVars = {
  clientId?: string;
  memberUserIds?: string[];
  name: string;
  // Omitted: the API's default for whether `clientId` is given.
  visibility?: MatterVisibility;
};

export const useCreateWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useIdempotentMutation({
    mutationFn: resourceMutation({
      mutation: "createWorkspace",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (
        vars: CreateWorkspaceVars,
        request: IdempotentRequest,
      ) => {
        const id = request.headers["Idempotency-Key"];
        const response = await api.workspaces.put({
          id: toSafeId<"workspace">(id),
          ...(vars.clientId !== undefined && {
            clientId: toSafeId<"contact">(vars.clientId),
          }),
          ...(vars.memberUserIds && vars.memberUserIds.length > 0
            ? { memberUserIds: vars.memberUserIds }
            : {}),
          ...(vars.visibility === undefined
            ? {}
            : { visibility: vars.visibility }),
          name: vars.name,
          filePropertyName: DEFAULT_FILE_PROPERTY_NAME,
        });

        if (response.error) {
          throw toAPIError(response.error);
        }

        return { id: toSafeId<"workspace">(id) };
      },
    }),
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
  documentNamingEnabled: boolean;
  leadUserId: string | null;
  name: string;
  reference: string;
};

type WorkspaceUpdateType = keyof WorkspaceUpdateValueByType;

export type WorkspaceUpdate =
  | { type: "clientId"; value: string; expectedClientId: string | null }
  // `confirmWidening` is the person's consent to show the matter to people
  // who cannot see it now; the API refuses a widening sent without it.
  | { type: "visibility"; value: MatterVisibility; confirmWidening?: true }
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
  documentNamingEnabled: "query-cache",
  leadUserId: "query-cache",
  name: "route-metadata",
  reference: "query-cache",
  visibility: "query-cache",
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
    case "documentNamingEnabled":
      return { documentNamingEnabled: update.value };
    case "leadUserId":
      return { leadUserId: update.value };
    case "name":
      return { name: update.value };
    case "reference":
      return { reference: update.value };
    case "visibility":
      return update.confirmWidening
        ? { visibility: update.value, confirmWidening: true as const }
        : { visibility: update.value };
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

  const writeUpdate = resourceMutation({
    mutation: "updateWorkspace",
    queryClient,
    mutationFn: async ({ update, workspaceId }: UpdateWorkspaceVars) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .post(workspaceUpdateBody(update));

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
  });

  return useMutation({
    mutationFn: writeUpdate,
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

export const useArchiveWorkspace = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ workspaceId }: ArchiveWorkspaceVars) => {
      await invokeCapability("matters.archive", async (request) => {
        const response = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .archive.post({}, request);

        return unwrapApiResponse(response);
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
      });
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "useArchiveWorkspace:failure",
        scope: { type: "handler", handlerId: "useArchiveWorkspace:failure" },
      });
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
  const queryClient = useQueryClient();

  return useMutation({
    retry: shouldRetryAPIRequest,
    // Organization scope: refresh the matter lists, not the deleted matter's
    // own readers, which would refetch into a 404.
    mutationFn: resourceMutation({
      mutation: "deleteWorkspace",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async ({ workspaceId }: DeleteWorkspaceVars) => {
        const response = await api
          .workspaces({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .delete({});

        if (response.error) {
          throw toAPIError(response.error);
        }
      },
    }),
    onSuccess: (_data, { workspaceId }: DeleteWorkspaceVars) => {
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

  return useIdempotentMutation({
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
