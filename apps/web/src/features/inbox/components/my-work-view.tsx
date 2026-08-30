import { useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckCircle2Icon,
  InboxIcon,
  MinusIcon,
  PlusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { isEntityPriority, type EntityPriority } from "@stll/api-contract";
import {
  isWorkObligationStatus,
  type WorkObligationStatus,
} from "@stll/api-contract/workflow-status";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { getDisplayedWorkDate } from "@/features/inbox/my-work.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { localISODate } from "@/lib/local-iso-date";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";
import type { MyWorkItem, MyWorkQueue } from "@/lib/workspaces/queries/my-work";
import {
  MY_WORK_QUEUES,
  myWorkKeys,
  myWorkOptions,
} from "@/lib/workspaces/queries/my-work";

const STATUS_COLORS = {
  unassigned: "bg-muted-foreground",
  awaiting_acknowledgement: "bg-warning",
  active: "bg-foreground-strong-muted dark:bg-foreground-strong-muted",
  completed: "bg-success dark:bg-success",
  cancelled: "bg-destructive dark:bg-destructive",
} as const satisfies Record<WorkObligationStatus, string>;

const PRIORITY_ICONS = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
} as const satisfies Record<EntityPriority, typeof MinusIcon>;

const PRIORITY_COLORS = {
  none: "text-muted-foreground",
  urgent: "text-destructive",
  high: "text-warning",
  medium: "text-warning",
  low: "text-foreground-muted dark:text-foreground",
} as const satisfies Record<EntityPriority, string>;

const PRIORITY_LABEL_KEY = {
  none: "tasks.priorityValues.none",
  urgent: "tasks.priorityValues.urgent",
  high: "tasks.priorityValues.high",
  medium: "tasks.priorityValues.medium",
  low: "tasks.priorityValues.low",
} as const satisfies Record<EntityPriority, TranslationKey>;

const MY_WORK_QUEUE_LABEL = {
  inbox: "tasks.queue.inbox",
  upcoming: "tasks.queue.upcoming",
  at_risk: "tasks.queue.atRisk",
  completed: "tasks.queue.completed",
} as const satisfies Record<MyWorkQueue, TranslationKey>;

const WORK_STATUS_LABEL_KEY = {
  unassigned: "inbox.unassigned",
  awaiting_acknowledgement: "tasks.acknowledgementRequired",
  active: "common.active",
  completed: "tasks.queue.completed",
  cancelled: "tasks.statusValues.cancelled",
} as const satisfies Record<WorkObligationStatus, TranslationKey>;

const ATTENTION_LABEL_KEY = {
  none: null,
  acknowledgement_required: "tasks.acknowledgementRequired",
  working_target_due: "tasks.workingTargetDue",
  hard_deadline_due: "tasks.hardDeadlineOverdue",
} as const satisfies Record<MyWorkItem["attention"], TranslationKey | null>;

const SKELETON_GROUP_KEYS = ["alpha", "beta"];
const SKELETON_ROW_KEYS = ["one", "two", "three"];

type GroupedWork = {
  workspace: { id: string; name: string };
  items: MyWorkItem[];
};

const groupByWorkspace = (items: readonly MyWorkItem[]): GroupedWork[] => {
  const groups = new Map<string, GroupedWork>();

  for (const item of items) {
    const existing = groups.get(item.workspaceId);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(item.workspaceId, {
      workspace: { id: item.workspaceId, name: item.workspaceName },
      items: [item],
    });
  }

  return Array.from(groups.values());
};

export const MyWorkView = ({ organizationId }: { organizationId: string }) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The queues partition the work, so the landing tab is the one asking the
  // owner for an answer, not the widest one.
  const [queue, setQueue] = useState<MyWorkQueue>("inbox");
  const asOf = localISODate();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery(myWorkOptions(queue, asOf));
  const { data: workspaces } = useQuery(workspacesRouteOptions(organizationId));

  useExternalSyncEffect(() => {
    if (!error) {
      return;
    }
    analytics.captureError(error);
    stellaToast.error(userErrorFromThrown(error, t("common.unexpectedError")));
  }, [analytics, error, t]);

  const items = data ? data.pages.flatMap((page) => page.items) : [];
  const groups = groupByWorkspace(items);

  const createTask = async (workspaceId: string) => {
    const created = await Result.tryPromise(async () => {
      const response = await api.tasks({ workspaceId }).put({
        name: t("tasks.untitled"),
      });
      return unwrapEden(response).entityId;
    });
    if (Result.isError(created)) {
      analytics.captureError(created.error);
      stellaToast.error(
        userErrorFromThrown(created.error, t("errors.actionFailed")),
      );
      return;
    }
    await queryClient.invalidateQueries({ queryKey: myWorkKeys.all });
    await navigate({
      to: "/workspaces/$workspaceId",
      params: { workspaceId },
    });
    useInspectorTabsStore.getState().openTask({
      taskId: created.value,
      workspaceId,
      isNew: true,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {MY_WORK_QUEUES.map((value) => (
            <Button
              aria-pressed={queue === value}
              key={value}
              onClick={() => setQueue(value)}
              size="sm"
              variant={queue === value ? "default" : "outline"}
            >
              {t(MY_WORK_QUEUE_LABEL[value])}
            </Button>
          ))}
        </div>
        <span className="flex-1" />
        {workspaces?.workspaces && workspaces.workspaces.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <PlusIcon />
              {t("tasks.newTask")}
            </MenuTrigger>
            <MenuPopup>
              {workspaces.workspaces.map((workspace) => (
                <MenuItem
                  key={workspace.id}
                  onClick={() => {
                    detached(
                      createTask(workspace.id),
                      "inbox.create-my-work-task",
                    );
                  }}
                >
                  <UserText>{workspace.name}</UserText>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </div>

      {isPending && <MyWorkSkeleton />}

      {!isPending && error && (
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-sm">
          <AlertCircleIcon className="size-8 opacity-40" />
          <p>{userErrorFromThrown(error, t("common.unexpectedError"))}</p>
          <Button
            onClick={() => {
              detached(refetch(), "inbox.retry-my-work");
            }}
            size="sm"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}

      {!isPending && !error && groups.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm">
          <CheckCircle2Icon className="size-8 opacity-40" />
          <p>{t("tasks.noWorkInQueue")}</p>
        </div>
      )}

      {!error &&
        groups.map((group) => (
          <section className="flex flex-col gap-1" key={group.workspace.id}>
            <h2 className="text-muted-foreground px-1 text-xs font-medium">
              <UserText>{group.workspace.name}</UserText>
            </h2>
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <WorkItemRow item={item} key={item.entityId} />
              ))}
            </div>
          </section>
        ))}

      {!error && hasNextPage && (
        <Button
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "inbox.fetch-my-work-page");
          }}
          size="sm"
          variant="outline"
        >
          {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};

const WorkItemRow = ({ item }: { item: MyWorkItem }) => {
  const t = useTranslations();
  const format = useFormatter();
  const workflowStatus = isWorkObligationStatus(item.workflowStatus)
    ? item.workflowStatus
    : "unassigned";
  const statusColor = STATUS_COLORS[workflowStatus];
  const priority = isEntityPriority(item.priority) ? item.priority : null;
  const priorityDisplay =
    priority === null
      ? null
      : {
          Icon: PRIORITY_ICONS[priority],
          color: PRIORITY_COLORS[priority],
          labelKey: PRIORITY_LABEL_KEY[priority],
        };
  const attentionLabelKey = ATTENTION_LABEL_KEY[item.attention];
  const displayedDate = getDisplayedWorkDate(item);
  const isDue =
    item.attention === "hard_deadline_due" ||
    item.attention === "working_target_due";
  const AttentionIcon = (() => {
    if (item.attention === "acknowledgement_required") {
      return InboxIcon;
    }
    if (item.attention === "hard_deadline_due") {
      return ShieldAlertIcon;
    }
    if (item.workflowStatus === "completed") {
      return CheckCircle2Icon;
    }
    return null;
  })();

  return (
    <button
      className="hover:bg-muted/50 flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-start text-sm transition-colors"
      onClick={() => {
        useInspectorTabsStore.getState().openTask({
          taskId: item.entityId,
          workspaceId: item.workspaceId,
          label: item.name,
        });
      }}
      type="button"
    >
      <span
        aria-label={t(WORK_STATUS_LABEL_KEY[workflowStatus])}
        className={cn("size-2 shrink-0 rounded-full", statusColor)}
        role="img"
      />
      <span className="min-w-0 flex-1 truncate">
        <UserText>{item.name}</UserText>
      </span>
      {priorityDisplay !== null && (
        <priorityDisplay.Icon
          aria-label={t(priorityDisplay.labelKey)}
          className={cn("size-3.5 shrink-0", priorityDisplay.color)}
          role="img"
        />
      )}
      {AttentionIcon && (
        <AttentionIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0",
            isDue ? "text-destructive" : "text-warning",
          )}
        />
      )}
      {attentionLabelKey !== null && (
        <span className="sr-only">{t(attentionLabelKey)}</span>
      )}
      {displayedDate && (
        <span
          className={cn(
            "text-muted-foreground flex shrink-0 items-center gap-1 text-xs",
            isDue && "text-destructive",
          )}
        >
          <CalendarIcon aria-hidden="true" className="size-3" />
          {format.dateTime(new Date(`${displayedDate}T00:00:00Z`), {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          })}
        </span>
      )}
    </button>
  );
};

const MyWorkSkeleton = () => (
  <>
    {SKELETON_GROUP_KEYS.map((groupKey) => (
      <div className="flex flex-col gap-1" key={groupKey}>
        <Skeleton className="mx-1 h-3 w-32" />
        {SKELETON_ROW_KEYS.map((rowKey) => (
          <div
            className="flex min-h-11 items-center gap-3 px-2"
            key={`${groupKey}-${rowKey}`}
          >
            <Skeleton className="size-2 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ms-auto h-4 w-14" />
          </div>
        ))}
      </div>
    ))}
  </>
);
