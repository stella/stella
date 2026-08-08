import { useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createFileRoute,
  getRouteApi,
  useNavigate,
} from "@tanstack/react-router";
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

import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterRefLink } from "@/components/matter-ref-link";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { workspacesRouteOptions } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";
import { LegacyTodosPage } from "@/routes/_protected.todos/-legacy-page";
import type {
  MyWorkItem,
  MyWorkQueue,
} from "@/routes/_protected.todos/-queries";
import { myWorkOptions } from "@/routes/_protected.todos/-queries";
import { getDisplayedWorkDate } from "@/routes/_protected.todos/-task-row.logic";

const protectedRouteApi = getRouteApi("/_protected");

const TodosPage = () =>
  env.VITE_FEATURE_GOVERNED_WORKFLOW ? <MyWorkPage /> : <LegacyTodosPage />;

export const Route = createFileRoute("/_protected/todos/")({
  loader: async ({ context }) => {
    if (!env.VITE_FEATURE_GOVERNED_WORKFLOW) {
      return;
    }

    await Promise.all([
      ensureRouteInfiniteQueryData(
        context.queryClient,
        myWorkOptions("upcoming", localISODate()),
      ),
      ensureRouteQueryData(
        context.queryClient,
        workspacesRouteOptions(context.user.activeOrganizationId),
      ),
    ]);
  },
  head: () => ({
    meta: [{ title: pageTitle("navigation.myTodos") }],
  }),
  component: TodosPage,
});

const STATUS_COLORS: Record<string, string> = {
  unassigned: "bg-muted-foreground",
  awaiting_acknowledgement: "bg-warning",
  active: "bg-foreground-strong-muted dark:bg-foreground-strong-muted",
  completed: "bg-success dark:bg-success",
  cancelled: "bg-destructive dark:bg-destructive",
};

const PRIORITY_ICONS: Record<string, typeof MinusIcon> = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
};

const PRIORITY_COLORS: Record<string, string> = {
  none: "text-muted-foreground",
  urgent: "text-destructive",
  high: "text-warning",
  medium: "text-warning",
  low: "text-foreground-muted dark:text-foreground",
};

const SKELETON_GROUP_KEYS = ["alpha", "beta", "gamma"];
const SKELETON_ROW_KEYS = ["one", "two", "three"];
// Vary the name-bar width per row so the skeleton reads as a real task list
// rather than a uniform block.
const SKELETON_ROW_NAME_WIDTHS: Record<string, string> = {
  one: "w-48",
  two: "w-64",
  three: "w-40",
};

type GroupedTasks = {
  workspace: { id: string; name: string };
  tasks: MyWorkItem[];
};

const groupByWorkspace = (tasks: readonly MyWorkItem[]): GroupedTasks[] => {
  const map = new Map<string, GroupedTasks>();

  for (const task of tasks) {
    const existing = map.get(task.workspaceId);
    if (existing) {
      existing.tasks.push(task);
    } else {
      map.set(task.workspaceId, {
        workspace: { id: task.workspaceId, name: task.workspaceName },
        tasks: [task],
      });
    }
  }

  return Array.from(map.values());
};

const localISODate = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

function MyWorkPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [queue, setQueue] = useState<MyWorkQueue>("upcoming");
  const asOf = localISODate();
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteQuery(myWorkOptions(queue, asOf));
  const { data: workspaces } = useQuery(
    workspacesRouteOptions(activeOrganizationId),
  );

  const tasks = data ? data.pages.flatMap((page) => page.items) : [];
  const groups = groupByWorkspace(tasks);

  useExternalSyncEffect(() => {
    if (!error) {
      return;
    }
    analytics.captureError(error);
    stellaToast.error(userErrorFromThrown(error, t("common.unexpectedError")));
  }, [analytics, error, t]);

  const handleCreateTask = async (wsId: string) => {
    const response = await api.tasks({ workspaceId: wsId }).put({
      queryKey: entitiesKeys.all(wsId),
      name: t("tasks.untitled"),
    });

    const entityId = unwrapEden(response).entityId;
    await queryClient.invalidateQueries({ queryKey: ["my-work"] });

    await navigate({
      to: "/workspaces/$workspaceId",
      params: { workspaceId: wsId },
    });
    useInspectorTabsStore
      .getState()
      .openTask({ taskId: entityId, workspaceId: wsId, isNew: true });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t p-4">
      <div className="flex items-center gap-2">
        <h1 className="me-auto text-lg font-semibold">
          {t("tasks.myWorkTitle")}
        </h1>
        {workspaces?.workspaces && workspaces.workspaces.length > 0 && (
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <PlusIcon />
              {t("tasks.newTask")}
            </MenuTrigger>
            <MenuPopup>
              {workspaces.workspaces.map((ws) => (
                <MenuItem
                  key={ws.id}
                  onClick={() => {
                    detached(
                      (async () => {
                        await handleCreateTask(ws.id);
                      })(),
                      "MyTodosPage",
                    );
                  }}
                >
                  {ws.name}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
        <div className="flex flex-wrap gap-1">
          <FilterButton
            active={queue === "inbox"}
            label={t("tasks.queue.inbox")}
            onClick={() => setQueue("inbox")}
          />
          <FilterButton
            active={queue === "upcoming"}
            label={t("tasks.queue.upcoming")}
            onClick={() => setQueue("upcoming")}
          />
          <FilterButton
            active={queue === "at_risk"}
            label={t("tasks.queue.atRisk")}
            onClick={() => setQueue("at_risk")}
          />
          <FilterButton
            active={queue === "completed"}
            label={t("tasks.queue.completed")}
            onClick={() => setQueue("completed")}
          />
        </div>
      </div>

      {isLoading && <TasksLoadingSkeleton />}

      {!isLoading && groups.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16">
          <EntityKindIcon className="size-10 opacity-40" kind="task" />
          <p className="text-sm">{t("tasks.noWorkInQueue")}</p>
          {workspaces?.workspaces && workspaces.workspaces.length > 0 && (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="default">
                    <PlusIcon />
                    {t("tasks.newTask")}
                  </Button>
                }
              />
              <MenuPopup>
                {workspaces.workspaces.map((ws) => (
                  <MenuItem
                    key={ws.id}
                    onClick={() => {
                      detached(
                        (async () => {
                          await handleCreateTask(ws.id);
                        })(),
                        "MyTodosPage",
                      );
                    }}
                  >
                    {ws.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
        </div>
      )}

      {groups.map((group) => (
        <div className="flex flex-col gap-1" key={group.workspace.id}>
          <h2 className="text-muted-foreground px-1 text-xs font-medium">
            {group.workspace.name}
          </h2>
          <div className="flex flex-col">
            {group.tasks.map((task) => (
              <TaskRow key={task.entityId} task={task} />
            ))}
          </div>
        </div>
      ))}

      {hasNextPage && (
        <Button
          className="self-center"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "MyTodosPage");
          }}
          size="sm"
          variant="outline"
        >
          {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
        </Button>
      )}
    </div>
  );
}

type FilterButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

const FilterButton = ({ label, active, onClick }: FilterButtonProps) => (
  <Button onClick={onClick} size="sm" variant={active ? "default" : "outline"}>
    {label}
  </Button>
);

const TaskRow = ({ task }: { task: MyWorkItem }) => {
  const statusColor =
    STATUS_COLORS[task.workflowStatus] ?? "bg-muted-foreground";

  const PriorityIcon = task.priority
    ? (PRIORITY_ICONS[task.priority] ?? MinusIcon)
    : null;
  const priorityColor = task.priority
    ? (PRIORITY_COLORS[task.priority] ?? "text-muted-foreground")
    : null;

  const displayedDate = getDisplayedWorkDate(task);
  const isDue =
    task.attention === "hard_deadline_due" ||
    task.attention === "working_target_due";
  let attentionColor = "text-success";
  if (task.attention === "acknowledgement_required") {
    attentionColor = "text-warning";
  } else if (isDue) {
    attentionColor = "text-destructive";
  }
  const AttentionIcon = (() => {
    if (task.attention === "acknowledgement_required") {
      return InboxIcon;
    }
    if (task.attention === "hard_deadline_due") {
      return ShieldAlertIcon;
    }
    if (task.workflowStatus === "completed") {
      return CheckCircle2Icon;
    }
    return null;
  })();

  return (
    <MatterRefLink
      className="group hover:bg-muted/50 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors"
      onClick={() => {
        useInspectorTabsStore.getState().openTask({
          taskId: task.entityId,
          workspaceId: task.workspaceId,
          label: task.name,
        });
      }}
      workspaceId={task.workspaceId}
    >
      <span className={cn("size-2 shrink-0 rounded-full", statusColor)} />
      <span className="min-w-0 flex-1 truncate">{task.name}</span>
      {PriorityIcon && priorityColor && (
        <PriorityIcon className={cn("size-3.5 shrink-0", priorityColor)} />
      )}
      {AttentionIcon && (
        <AttentionIcon className={cn("size-3.5 shrink-0", attentionColor)} />
      )}
      {displayedDate && (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1",
            "text-muted-foreground text-xs",
            isDue && "text-destructive",
          )}
        >
          <CalendarIcon className="size-3" />
          {new Date(displayedDate).toLocaleDateString(getFormattingLocale(), {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </span>
      )}
    </MatterRefLink>
  );
};

// Mirrors the loaded grouped-list layout (group header + task rows) so only the
// values fade in when data lands, instead of a layout shift from blank to list.
const TasksLoadingSkeleton = () => (
  <>
    {SKELETON_GROUP_KEYS.map((groupKey) => (
      <div className="flex flex-col gap-1" key={groupKey}>
        <Skeleton className="mx-1 h-4 w-32" />
        <div className="flex flex-col">
          {SKELETON_ROW_KEYS.map((rowKey) => (
            <div
              className="flex items-center gap-3 px-2 py-1.5"
              key={`${groupKey}-${rowKey}`}
            >
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <Skeleton
                className={cn("h-4", SKELETON_ROW_NAME_WIDTHS[rowKey])}
              />
              <Skeleton className="ms-auto size-3.5 shrink-0 rounded-sm" />
              <Skeleton className="h-4 w-14 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    ))}
  </>
);
