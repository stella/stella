import { useRef, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  HistoryIcon,
  InboxIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  closeInspectorTabsForEntities,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import {
  isTaskPriority,
  isListItemType,
  isTaskStatus,
  toISODate,
} from "@/components/workspaces/tasks/task-detail-constants";
import {
  getTaskDetailInstanceKey,
  getTaskStatusUpdate,
  taskUpdateBody,
  taskUpdateClearsWorkflowReason,
  workflowUpdateBody,
  workflowUpdateClearsReason,
} from "@/components/workspaces/tasks/task-detail-panel.logic";
import type {
  TaskUpdate,
  WorkflowUpdate,
} from "@/components/workspaces/tasks/task-detail-panel.logic";
import { LinksSection } from "@/components/workspaces/tasks/task-links";
import {
  AssigneePicker,
  DatePickerPopover,
  ItemTypeSelect,
  MetadataRow,
  OwnerPicker,
  PrioritySelect,
  StatusSelect,
  WorkTypeSelect,
} from "@/components/workspaces/tasks/task-metadata";
import { SubtasksSection } from "@/components/workspaces/tasks/task-subtasks";
import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { localISODate } from "@/lib/local-iso-date";
import { DAY_AND_MONTH_FORMAT } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { workspacesKeys } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { legalListKeys } from "@/lib/workspaces/queries/legal-lists";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";
import { taskDetailOptions, taskKeys } from "@/lib/workspaces/queries/tasks";

import type {
  ListItemType,
  TaskPriority,
  TaskStatus,
} from "./task-detail-constants";

// -- Component --

type TaskDetailPanelProps = {
  workspaceId: string;
  taskId: string;
};

export const TaskDetailPanel = (props: TaskDetailPanelProps) => (
  <TaskDetailPanelContent key={getTaskDetailInstanceKey(props)} {...props} />
);

const TaskDetailPanelContent = ({
  workspaceId,
  taskId,
}: TaskDetailPanelProps) => {
  const t = useTranslations("tasks");
  const tCommon = useTranslations("common");
  const closeTab = useInspectorTabsStore((s) => s.closeTab);
  const setMinimized = useInspectorTabsStore((s) => s.setMinimized);
  const isNewTask = useInspectorTabsStore((s) => {
    const found = s.tabs.find((tab) => tab.id === taskId);
    return found?.type === "task" && found.isNew;
  });
  const creationStatus = useInspectorTabsStore((s) => {
    const found = s.tabs.find((tab) => tab.id === taskId);
    return found?.type === "task" ? found.creationStatus : "ready";
  });
  const clearNewFlag = useInspectorTabsStore((s) => s.clearTaskNewFlag);
  const handleBack = () => setMinimized(true);
  const handleClose = () => closeTab(taskId);
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const userId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.id,
  });

  const {
    data: task,
    error: taskError,
    isLoading,
  } = useQuery({
    ...taskDetailOptions(workspaceId, taskId),
    enabled: creationStatus === "ready",
  });

  useExternalSyncEffect(() => {
    if (APIError.is(taskError) && taskError.status === 404) {
      closeInspectorTabsForEntities([taskId]);
    }
  }, [taskError, taskId]);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [workflowReason, setWorkflowReason] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const name = task?.name ?? t("untitled");

  const updateMutation = useMutation({
    mutationFn: async (update: TaskUpdate) => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .patch({
          ...taskUpdateBody(update),
          taskId: toSafeId<"entity">(update.taskId),
        });
      return unwrapEden(response);
    },
    onSuccess: async (_data, variables) => {
      if (taskUpdateClearsWorkflowReason(variables)) {
        setWorkflowReason("");
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: taskKeys.detail(workspaceId, taskId),
        }),
        queryClient.invalidateQueries({
          queryKey: workspacesKeys.overview(workspaceId),
        }),
        queryClient.invalidateQueries({ queryKey: myWorkKeys.all }),
        queryClient.invalidateQueries({
          queryKey: legalListKeys.all(workspaceId),
        }),
      ]);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.error(userErrorFromThrown(error, tCommon("unexpectedError")));
    },
  });

  const invalidateWorkflow = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: taskKeys.detail(workspaceId, taskId),
      }),
      queryClient.invalidateQueries({ queryKey: myWorkKeys.all }),
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.overview(workspaceId),
      }),
    ]);
  };

  const workflowMutation = useMutation({
    mutationFn: async (update: WorkflowUpdate) => {
      const response = await api["work-obligations"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })({ entityId: toSafeId<"entity">(taskId) }).patch({
        ...workflowUpdateBody(update),
      });
      return unwrapEden(response);
    },
    onSuccess: async (_data, variables) => {
      if (workflowUpdateClearsReason(variables)) {
        setWorkflowReason("");
      }
      await invalidateWorkflow();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.error(userErrorFromThrown(error, tCommon("unexpectedError")));
    },
  });

  const workflowActionMutation = useMutation({
    mutationFn: async (
      action:
        | { type: "acknowledge" }
        | {
            type: "transition";
            action: "complete" | "cancel" | "reopen";
            reason?: string;
          },
    ) => {
      const endpoint = api["work-obligations"]({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })({ entityId: toSafeId<"entity">(taskId) });
      if (action.type === "acknowledge") {
        return unwrapEden(await endpoint.acknowledge.post({}));
      }
      return unwrapEden(
        await endpoint.transition.post({
          action: action.action,
          ...(action.reason ? { reason: action.reason } : {}),
        }),
      );
    },
    onSuccess: async (_data, variables) => {
      if (variables.type === "transition" && variables.reason) {
        setWorkflowReason("");
      }
      await invalidateWorkflow();
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.error(userErrorFromThrown(error, tCommon("unexpectedError")));
    },
  });

  // Auto-assign current user and focus name for new tasks
  const didAutoAssign = useRef(false);
  useExternalSyncEffect(() => {
    if (isNewTask && task) {
      setEditNameValue("");
      setIsEditingName(true);
      clearNewFlag(taskId);

      // Auto-assign the signed-in user
      if (!didAutoAssign.current) {
        didAutoAssign.current = true;
        const alreadyAssigned = task.assignees.some(
          (a) => a.user?.id === userId,
        );
        if (!alreadyAssigned) {
          detached(
            (async () => {
              try {
                const response = await api
                  .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
                  .assignees.post({
                    taskId: toSafeId<"entity">(taskId),
                    userId: toSafeId<"user">(userId),
                  });
                if (response.error) {
                  analytics.captureError(toAPIError(response.error));
                  await queryClient.invalidateQueries({
                    queryKey: taskKeys.detail(workspaceId, taskId),
                  });
                  return;
                }
                await Promise.all([
                  queryClient.invalidateQueries({
                    queryKey: taskKeys.detail(workspaceId, taskId),
                  }),
                  queryClient.invalidateQueries({
                    queryKey: workspacesKeys.overview(workspaceId),
                  }),
                  queryClient.invalidateQueries({
                    queryKey: myWorkKeys.all,
                  }),
                ]);
              } catch (error: unknown) {
                analytics.captureError(error);
                detached(
                  queryClient.invalidateQueries({
                    queryKey: taskKeys.detail(workspaceId, taskId),
                  }),
                  "task-detail-panel.invalidate",
                );
              }
            })(),
            "task-detail-panel.auto-assign",
          );
        } else {
          detached(
            queryClient.invalidateQueries({ queryKey: myWorkKeys.all }),
            "task-detail-panel.invalidate",
          );
        }
      }
    }
  }, [
    isNewTask,
    task,
    isLoading,
    clearNewFlag,
    taskId,
    userId,
    workspaceId,
    queryClient,
    analytics,
  ]);

  const startEditingName = () => {
    setEditNameValue(task?.name ?? "");
    setIsEditingName(true);
  };

  const commitName = () => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== (task?.name ?? "")) {
      updateMutation.mutate({ taskId, type: "name", value: trimmed });
    }
    setIsEditingName(false);
  };

  const handleStatusChange = (value: TaskStatus | null) => {
    if (!value) {
      return;
    }
    updateMutation.mutate(getTaskStatusUpdate(taskId, value, workflowReason));
  };

  const handlePriorityChange = (value: TaskPriority | null) => {
    if (!value) {
      return;
    }
    updateMutation.mutate({ taskId, type: "priority", value });
  };

  const handleDueDateChange = (value: string | null) => {
    if (env.VITE_FEATURE_GOVERNED_WORKFLOW) {
      workflowMutation.mutate({ type: "workingTargetDate", value });
      return;
    }
    updateMutation.mutate({ taskId, type: "dueDate", value });
  };

  const handleItemTypeChange = (value: ListItemType | null) => {
    if (!value) {
      return;
    }
    updateMutation.mutate({ taskId, type: "listItemType", value });
  };

  const handleSubtaskToggle = (
    subtaskId: string,
    currentStatus: string | null,
  ) => {
    const newStatus = currentStatus === "done" ? "open" : "done";
    updateMutation.mutate({
      taskId: subtaskId,
      type: "status",
      value: { status: newStatus },
    });
  };

  // Sync task status to the inspector tab icon so the vertical
  // tab bar reflects the current status color.
  let resolvedStatus: TaskStatus | null = null;
  if (task) {
    resolvedStatus = isTaskStatus(task.status) ? task.status : "open";
  }
  useExternalSyncEffect(() => {
    if (resolvedStatus !== null) {
      useInspectorTabsStore.getState().updateTaskStatus(taskId, resolvedStatus);
    }
  }, [taskId, resolvedStatus]);

  if (creationStatus === "pending" || isLoading) {
    return (
      <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b px-2",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Button
            aria-label={tCommon("back")}
            className="-ms-1 md:hidden"
            onClick={handleBack}
            size="icon-sm"
            title={tCommon("back")}
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
          </Button>
          <Skeleton className="h-4 flex-1" />
          <Button
            aria-label={tCommon("close")}
            onClick={handleClose}
            size="icon-xs"
            title={tCommon("close")}
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b px-2",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Button
            aria-label={tCommon("back")}
            className="-ms-1 md:hidden"
            onClick={handleBack}
            size="icon-sm"
            title={tCommon("back")}
            variant="ghost"
          >
            <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
          </Button>
          <span className="text-muted-foreground flex-1 text-xs">
            {t("notFound")}
          </span>
          <Button
            aria-label={tCommon("close")}
            onClick={handleClose}
            size="icon-xs"
            title={tCommon("close")}
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  const currentStatus = isTaskStatus(task.status) ? task.status : "open";
  const currentPriority = isTaskPriority(task.priority)
    ? task.priority
    : "none";
  const currentItemType = isListItemType(task.listItemType)
    ? task.listItemType
    : "task";

  const dueDateISO = toISODate(task.dueDate);
  const isOverdue =
    dueDateISO &&
    currentStatus !== "done" &&
    currentStatus !== "cancelled" &&
    dueDateISO < localISODate();

  // Drop assignees/links whose related record is null (e.g. a deleted user or
  // entity) so downstream components can rely on a non-null relation.
  const assignees = task.assignees.filter(
    (a): a is typeof a & { user: NonNullable<typeof a.user> } =>
      a.user !== null,
  );
  const linkedFrom = task.linksAsSource.filter(
    (
      link,
    ): link is typeof link & {
      targetEntity: NonNullable<typeof link.targetEntity>;
    } => link.targetEntity !== null,
  );
  const linkedTo = task.linksAsTarget.filter(
    (
      link,
    ): link is typeof link & {
      sourceEntity: NonNullable<typeof link.sourceEntity>;
    } => link.sourceEntity !== null,
  );
  const workflow = env.VITE_FEATURE_GOVERNED_WORKFLOW
    ? task.workObligation
    : null;
  const hardDeadlineDate = toISODate(workflow?.hardDeadlineDate);
  const hardDeadlineOverdue =
    hardDeadlineDate.length > 0 &&
    workflow?.status !== "completed" &&
    workflow?.status !== "cancelled" &&
    hardDeadlineDate < localISODate();
  const sourceLabel = (() => {
    if (!workflow) {
      return "";
    }
    if (workflow.sourceDescription) {
      return workflow.sourceDescription;
    }
    switch (workflow.sourceType) {
      case "manual":
        return t("sourceTypeValues.manual");
      case "calendar":
        return t("sourceTypeValues.calendar");
      case "email":
        return tCommon("email");
      case "document":
        return tCommon("document");
      case "court":
        return tCommon("court");
      case "import":
        return tCommon("import");
      case "api":
        return t("sourceTypeValues.api");
      case "flow":
        return tCommon("workflow");
      default: {
        workflow.sourceType satisfies never;
        return panic(`Unhandled source type: ${String(workflow.sourceType)}`);
      }
    }
  })();

  return (
    <div className="bg-background flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b px-2",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button
          aria-label={tCommon("back")}
          className="-ms-1 md:hidden"
          onClick={handleBack}
          size="icon-sm"
          title={tCommon("back")}
          variant="ghost"
        >
          <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {isNewTask ? t("newTask") : name}
        </span>
        <Button
          aria-label={tCommon("close")}
          onClick={handleClose}
          size="icon-xs"
          title={tCommon("close")}
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* Editable task name */}
        <div className="px-4 pt-3 pb-2">
          {isEditingName ? (
            <Input
              autoFocus
              className="text-base font-semibold"
              onBlur={commitName}
              onChange={(e) => setEditNameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setIsEditingName(false);
                  setEditNameValue(task.name);
                }
              }}
              placeholder={t("untitled")}
              ref={nameInputRef}
              value={editNameValue}
            />
          ) : (
            <button
              className="hover:text-foreground-strong-muted w-full text-start text-base font-semibold transition-colors"
              onClick={startEditingName}
              type="button"
            >
              {name}
            </button>
          )}
        </div>

        {/* Metadata */}
        <div className="space-y-3 px-4 py-3">
          {env.VITE_FEATURE_LEGAL_LISTS && (
            <MetadataRow label={tCommon("type")}>
              <ItemTypeSelect
                ariaLabel={tCommon("type")}
                onChange={handleItemTypeChange}
                value={currentItemType}
              />
            </MetadataRow>
          )}

          <MetadataRow label={t("status")}>
            <StatusSelect onChange={handleStatusChange} value={currentStatus} />
          </MetadataRow>

          <MetadataRow label={t("priority")}>
            <PrioritySelect
              onChange={handlePriorityChange}
              value={currentPriority}
            />
          </MetadataRow>

          <MetadataRow label={t("dueDate")}>
            <DatePickerPopover
              isOverdue={isOverdue === true}
              onChange={handleDueDateChange}
              value={task.dueDate}
            />
          </MetadataRow>

          {workflow && (
            <>
              <MetadataRow label={tCommon("type")}>
                <WorkTypeSelect
                  onChange={(type) => {
                    if (type) {
                      workflowMutation.mutate({ type: "type", value: type });
                    }
                  }}
                  value={workflow.type}
                />
              </MetadataRow>

              <MetadataRow label={t("owner")}>
                <OwnerPicker
                  disabled={workflowMutation.isPending}
                  onChange={(ownerUserId) => {
                    const reason = workflowReason.trim();
                    workflowMutation.mutate({
                      type: "owner",
                      value: {
                        ownerUserId,
                        ...(reason ? { reason } : {}),
                      },
                    });
                  }}
                  owner={workflow.owner}
                  reason={workflowReason}
                  workspaceId={workspaceId}
                />
              </MetadataRow>

              <MetadataRow label={t("hardDeadline")}>
                <DatePickerPopover
                  isOverdue={hardDeadlineOverdue}
                  onChange={(hardDeadline) => {
                    const reason = workflowReason.trim();
                    workflowMutation.mutate({
                      type: "hardDeadline",
                      value: {
                        hardDeadlineDate: hardDeadline,
                        ...(workflow.hardDeadlineDate && reason
                          ? { reason }
                          : {}),
                      },
                    });
                  }}
                  value={workflow.hardDeadlineDate}
                />
              </MetadataRow>

              <MetadataRow label={tCommon("source")}>
                <span className="text-muted-foreground px-1.5 text-sm">
                  <span dir="auto">{sourceLabel}</span>
                </span>
              </MetadataRow>

              {task.flowReview !== null && (
                <MetadataRow label={tCommon("workflow")}>
                  <Button
                    render={
                      <Link
                        params={{ workspaceId }}
                        search={{ run: task.flowReview.runId }}
                        to="/workspaces/$workspaceId/workflows"
                      />
                    }
                    size="sm"
                    variant="outline"
                  >
                    {t("openWorkflowRun")}
                  </Button>
                </MetadataRow>
              )}

              <MetadataRow label={t("delegationReason")}>
                <Input
                  aria-label={t("delegationReason")}
                  className="min-h-11"
                  maxLength={1000}
                  onChange={(event) => setWorkflowReason(event.target.value)}
                  placeholder={t("delegationReason")}
                  value={workflowReason}
                />
              </MetadataRow>
            </>
          )}

          <MetadataRow label={t("assignees")}>
            <AssigneePicker
              assignees={assignees}
              taskId={taskId}
              workspaceId={workspaceId}
            />
          </MetadataRow>
        </div>

        {workflow && (
          <div className="border-t px-4 py-3">
            {workflow.status === "awaiting_acknowledgement" &&
              workflow.ownerUserId === userId && (
                <div className="bg-warning/10 mb-3 flex items-center gap-2 rounded-md p-2 text-sm">
                  <InboxIcon className="text-warning size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {t("acknowledgementRequired")}
                  </span>
                  <Button
                    disabled={workflowActionMutation.isPending}
                    onClick={() =>
                      workflowActionMutation.mutate({ type: "acknowledge" })
                    }
                    size="sm"
                  >
                    {t("acknowledge")}
                  </Button>
                </div>
              )}

            <div className="flex flex-wrap gap-2">
              {workflow.status === "active" &&
                workflow.ownerUserId === userId && (
                  <Button
                    disabled={workflowActionMutation.isPending}
                    onClick={() =>
                      workflowActionMutation.mutate({
                        type: "transition",
                        action: "complete",
                      })
                    }
                    size="sm"
                  >
                    <CheckCircle2Icon />
                    {t("completeWork")}
                  </Button>
                )}
              {(workflow.status === "completed" ||
                workflow.status === "cancelled") && (
                <Button
                  disabled={workflowActionMutation.isPending}
                  onClick={() =>
                    workflowActionMutation.mutate({
                      type: "transition",
                      action: "reopen",
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  <RotateCcwIcon />
                  {t("reopenWork")}
                </Button>
              )}
              {hardDeadlineOverdue && (
                <span className="text-destructive flex items-center gap-1 text-xs">
                  <ShieldAlertIcon className="size-3.5" />
                  {t("hardDeadlineOverdue")}
                </span>
              )}
            </div>
          </div>
        )}

        {workflow && (
          <div className="border-t px-4 py-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
              <HistoryIcon className="size-3.5" />
              {t("activity")}
            </h3>
            <div className="flex flex-col gap-2">
              {workflow.events.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  {t("noActivity")}
                </p>
              )}
              {workflow.events.slice(0, 10).map((event) => {
                const eventLabel = (() => {
                  switch (event.type) {
                    case "created":
                      return t("activityTypes.created");
                    case "owner_assigned":
                      return t("activityTypes.ownerAssigned");
                    case "acknowledged":
                      return t("activityTypes.acknowledged");
                    case "delegated":
                      return t("activityTypes.delegated");
                    case "working_target_changed":
                      return t("activityTypes.workingTargetChanged");
                    case "hard_deadline_changed":
                      return t("activityTypes.hardDeadlineChanged");
                    case "type_changed":
                      return t("activityTypes.typeChanged");
                    case "provenance_changed":
                      return t("activityTypes.provenanceChanged");
                    case "completed":
                      return t("activityTypes.completed");
                    case "reopened":
                      return t("activityTypes.reopened");
                    case "cancelled":
                      return t("activityTypes.cancelled");
                    default: {
                      event.type satisfies never;
                      return panic(`Unhandled type: ${String(event.type)}`);
                    }
                  }
                })();
                return (
                  <div className="flex gap-2 text-xs" key={event.id}>
                    <span className="bg-muted mt-1 size-1.5 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1">
                      <p>
                        {eventLabel}
                        {event.actor?.name && (
                          <>
                            {" · "}
                            <bdi>{event.actor.name}</bdi>
                          </>
                        )}
                      </p>
                      {event.reason && (
                        <p
                          className="text-muted-foreground wrap-break-word"
                          dir="auto"
                        >
                          {event.reason}
                        </p>
                      )}
                    </div>
                    <time className="text-muted-foreground shrink-0">
                      {new Date(event.occurredAt).toLocaleDateString(
                        getFormattingLocale(),
                        DAY_AND_MONTH_FORMAT,
                      )}
                    </time>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Subtasks */}
        <SubtasksSection
          onToggle={handleSubtaskToggle}
          subtasks={task.children}
        />

        {/* Links */}
        <LinksSection linkedFrom={linkedFrom} linkedTo={linkedTo} />
      </ScrollArea>
    </div>
  );
};
