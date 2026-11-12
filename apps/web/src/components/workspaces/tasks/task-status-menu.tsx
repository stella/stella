import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import type { EntityAction } from "@stll/ui/entity-actions";
import { cn } from "@stll/ui/utils";

import { notifyTaskCompletion } from "@/components/workspaces/tasks/task-completion-toast";
import {
  isTaskStatus,
  STATUS_COLORS,
  STATUS_ICONS,
  TASK_STATUSES,
} from "@/components/workspaces/tasks/task-detail-constants";
import type { TaskStatus } from "@/components/workspaces/tasks/task-detail-constants";
import { api } from "@/lib/api";
import { useCapabilityMutation } from "@/lib/capabilities/use-capability-mutation";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { resourceMutation } from "@/lib/workspace-realtime";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";
import { taskDetailOptions, taskKeys } from "@/lib/workspaces/queries/tasks";

/**
 * Saves a status picked from a task's context menu, wherever that menu opens.
 * The menu keeps the status it opened with, so the status to go back to is
 * read when the change is made. The returned promise, not a per-call
 * `onSuccess`, keeps the completion toast alive after the menu closes; a
 * failure is reported by the mutation's own `onError`.
 */
const useTaskStatusChange = (workspaceId: string) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const mutation = useCapabilityMutation({
    capability: "tasks.update",
    target: resourceRef({
      type: RESOURCE_TYPE.WORKSPACE,
      id: toSafeId<"workspace">(workspaceId),
    }),
    mutationFn: async (
      variables: { taskId: string; status: TaskStatus },
      request,
    ) =>
      await resourceMutation({
        mutation: "updateTaskStatus",
        queryClient,
        mutationFn: async ({
          taskId,
          status,
        }: {
          taskId: string;
          status: TaskStatus;
          workspaceId: string;
          entityId: string;
        }) => {
          const response = await api
            .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
            .patch({ taskId: toSafeId<"entity">(taskId), status }, request);
          return unwrapApiResponse(response);
        },
      })({ ...variables, workspaceId, entityId: variables.taskId }),
    onSuccess: async (_data, variables) => {
      // `entitiesKeys.all` also covers the sidebar's matter activity list.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, variables.taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: myWorkKeys.all }),
      ]);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  return (taskId: string, status: TaskStatus, shown: TaskStatus) => {
    const { queryKey } = taskDetailOptions(workspaceId, taskId);
    const read = () => queryClient.getQueryData(queryKey)?.status;
    const stored = read();
    const previous = isTaskStatus(stored) ? stored : shown;
    const previousKnown = !mutation.isPending;
    const saveStatus = async () => {
      const saved = await Result.tryPromise(
        async () => await mutation.mutateAsync({ taskId, status }),
      );
      if (Result.isOk(saved)) {
        notifyTaskCompletion({
          currentStatus: read,
          next: status,
          previous: previousKnown ? previous : null,
          restore: (restored) => mutation.mutate({ taskId, status: restored }),
        });
      }
    };
    detached(saveStatus(), "task-status-menu.status");
  };
};

/**
 * The one "Status" action every task menu shows: a submenu of the statuses,
 * the current one checked. Menus take it as data (`EntityActions`,
 * `ContextMenuActionItems`), so no menu hand-writes its own copy.
 */
export const useTaskStatusAction = (workspaceId: string) => {
  const t = useTranslations();
  const changeTaskStatus = useTaskStatusChange(workspaceId);
  return (taskId: string, status: TaskStatus): EntityAction => {
    const CurrentIcon = STATUS_ICONS[status];
    return {
      icon: <CurrentIcon className={cn("size-4", STATUS_COLORS[status])} />,
      label: t("common.status"),
      submenu: TASK_STATUSES.map((option) => {
        const Icon = STATUS_ICONS[option];
        return {
          checked: option === status,
          icon: <Icon className={cn("size-4", STATUS_COLORS[option])} />,
          label: t(`tasks.statusValues.${option}`),
          onClick: () => {
            if (option !== status) {
              changeTaskStatus(taskId, option, status);
            }
          },
        };
      }),
    };
  };
};
