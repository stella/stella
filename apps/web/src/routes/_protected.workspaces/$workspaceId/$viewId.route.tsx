import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";
import * as v from "valibot";

import { Skeleton } from "@stll/ui/components/skeleton";
import { cn } from "@stll/ui/lib/utils";

import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import type { ViewLayout, WorkspaceView } from "@/lib/types";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  entitiesWindowOptions,
  filesystemEntitiesOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  getWeekStart,
  isWorkspaceDocumentRoutePath,
  resolveKanbanGroupBy,
  toISODate,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";

// v.object: validateSearch receives the full URL search params
// including params from child routes; strictObject would reject them.
const searchSchema = v.object({
  folder: optionalSearchStringSchema(),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId",
)({
  component: RouteComponent,
  pendingComponent: ViewPendingComponent,
  validateSearch: searchSchema,
  beforeLoad: ({ params }) => {
    // Reject obviously invalid viewIds (e.g. "workspaces" from stale doubled
    // URLs). Allow UUIDs and the special "all" slug used by the PDF viewer.
    const VALID_VIEW_ID =
      /^(?:all|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/iu;
    if (!VALID_VIEW_ID.test(params.viewId)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console -- dev-only stack trace to debug stale doubled URLs
        console.trace(
          `[stella] beforeLoad rejected viewId="${params.viewId}" — redirecting. URL:`,
          globalThis.location.href,
        );
      }
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
        replace: true,
      });
    }
  },
  loader: async ({ context, location, params }) => {
    const { workspaceId, viewId } = params;
    const { queryClient } = context;
    const isDocumentRoute = isWorkspaceDocumentRoutePath(location.pathname);

    const views = await ensureRouteQueryData(
      queryClient,
      viewsOptions(workspaceId),
    );
    const activeView = views.find((view) => view.id === viewId) ?? views.at(0);

    if (!activeView) {
      return;
    }

    if (activeView.layout.type === "overview") {
      if (isDocumentRoute) {
        return;
      }

      await ensureRouteQueryData(queryClient, overviewOptions(workspaceId));

      const weekStart = getWeekStart(getFormattingLocale());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const prevWeekStart = new Date(weekStart);
      prevWeekStart.setDate(prevWeekStart.getDate() - 7);
      const prevWeekEnd = new Date(weekStart);
      prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);

      detached(
        prefetchRouteQuery(
          queryClient,
          timeEntriesOptions(workspaceId, {
            dateFrom: toISODate(weekStart),
            dateTo: toISODate(weekEnd),
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "loader",
      );
      detached(
        prefetchRouteQuery(
          queryClient,
          timeEntriesOptions(workspaceId, {
            dateFrom: toISODate(prevWeekStart),
            dateTo: toISODate(prevWeekEnd),
          }),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "loader",
      );
      detached(
        prefetchRouteQuery(
          queryClient,
          workspaceMembersOptions(workspaceId),
          (error: unknown) => {
            getAnalytics().captureError(error);
          },
        ),
        "loader",
      );
      return;
    }

    const shouldLoadViewProperties =
      activeView.layout.type === "filesystem" ||
      activeView.layout.type === "table" ||
      activeView.layout.type === "kanban";
    const properties = shouldLoadViewProperties
      ? await ensureRouteQueryData(queryClient, propertiesOptions(workspaceId))
      : [];
    const requiredPropertyIds =
      activeView.layout.type === "kanban"
        ? [
            resolveKanbanGroupBy(
              activeView.layout.groupByPropertyId ?? "",
              properties,
            ),
          ]
        : [];
    const shouldLoadVisibleFields =
      activeView.layout.type === "filesystem" ||
      activeView.layout.type === "table";
    const fieldIds = shouldLoadVisibleFields
      ? visibleEntityFieldIds({
          hiddenProperties: activeView.layout.hiddenProperties,
          properties,
          requiredPropertyIds,
        })
      : [];
    const fieldMode = shouldLoadVisibleFields ? "visible" : "full";

    if (activeView.layout.type === "table") {
      await ensureRouteInfiniteQueryData(
        queryClient,
        entitiesWindowOptions({
          workspaceId,
          filters: activeView.layout.filters,
          sorts: activeView.layout.sorts,
          limit: DEFAULT_ENTITY_WINDOW_SIZE,
          excludedKinds: ["folder", "task"],
          fieldMode,
          fieldIds,
        }),
      );
      return;
    }

    if (activeView.layout.type === "filesystem") {
      await ensureRouteQueryData(
        queryClient,
        filesystemEntitiesOptions({
          workspaceId,
          filters: activeView.layout.filters,
          sorts: activeView.layout.sorts,
          fieldMode,
          fieldIds,
        }),
      );
      return;
    }

    if (activeView.layout.type === "calendar") {
      return;
    }

    if (activeView.layout.type === "kanban") {
      return;
    }

    return;
  },
});

function RouteComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const viewsQueryOptions = viewsOptions(workspaceId);
  const { data: activeView } = useSuspenseQuery({
    ...viewsQueryOptions,
    select: (data) => data.find((view) => view.id === viewId) ?? data.at(0),
  });

  if (!activeView) {
    return null;
  }

  if (activeView.layout.type === "overview") {
    return (
      <OverviewViewContent activeView={activeView} workspaceId={workspaceId} />
    );
  }

  return (
    <EntityViewContent activeView={activeView} workspaceId={workspaceId} />
  );
}

type ViewContentProps = {
  activeView: WorkspaceView;
  workspaceId: string;
};

type VisibleFieldsView = WorkspaceView & {
  layout: Extract<WorkspaceView["layout"], { type: "filesystem" }>;
};

function OverviewViewContent({ activeView, workspaceId }: ViewContentProps) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function EntityViewContent({ activeView, workspaceId }: ViewContentProps) {
  if (hasVisibleFieldsLayout(activeView)) {
    return (
      <VisibleFieldEntityViewContent
        activeView={activeView}
        workspaceId={workspaceId}
      />
    );
  }

  if (activeView.layout.type === "table") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  if (activeView.layout.type === "calendar") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  if (activeView.layout.type === "kanban") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

const hasVisibleFieldsLayout = (
  view: WorkspaceView,
): view is VisibleFieldsView => view.layout.type === "filesystem";

function VisibleFieldEntityViewContent({
  activeView,
  workspaceId,
}: ViewContentProps & { activeView: VisibleFieldsView }) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function ViewShell({ activeView, workspaceId }: ViewContentProps) {
  const navigate = Route.useNavigate();
  const matches = useMatches();
  const isOnPdfRoute = matches.some((m) => m.fullPath.endsWith("/document"));

  // File detail view: hide the view chrome; breadcrumbs provide navigation
  // back to the matter.
  if (isOnPdfRoute) {
    return <Outlet />;
  }

  return (
    <>
      <div className="flex min-w-0 flex-col border-b md:flex-row md:items-center md:justify-between">
        <div
          className={cn(
            "flex min-w-0 items-center",
            TOOLBAR_ROW_HEIGHT,
            activeView.layout.type !== "overview" && "border-b md:border-b-0",
          )}
        >
          <ViewSwitcher
            activeViewId={activeView.id}
            onViewChange={(viewId) => {
              detached(
                navigate({
                  to: "/workspaces/$workspaceId/$viewId",
                  params: { workspaceId, viewId },
                  search: { page: undefined },
                }),
                "ViewShell",
              );
            }}
            workspaceId={workspaceId}
          />
        </div>
        {activeView.layout.type !== "overview" && (
          <ViewToolbar view={activeView} workspaceId={workspaceId} />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </div>
    </>
  );
}

const PENDING_TABLE_ROW_KEYS = [
  "r1",
  "r2",
  "r3",
  "r4",
  "r5",
  "r6",
  "r7",
  "r8",
  "r9",
  "r10",
  "r11",
  "r12",
];
const PENDING_TABLE_CELLS = [
  { key: "name", width: "w-48" },
  { key: "c2", width: "w-28" },
  { key: "c3", width: "w-20" },
  { key: "c4", width: "w-32" },
  { key: "c5", width: "w-24" },
] as const;
const PENDING_KANBAN_COLUMN_KEYS = ["k1", "k2", "k3", "k4"];
const PENDING_KANBAN_CARD_KEYS = ["card1", "card2", "card3"];
const PENDING_OVERVIEW_CARD_KEYS = ["o1", "o2", "o3", "o4"];

const PendingTableBody = () => (
  <div className="flex flex-col">
    <div className="flex items-center gap-4 border-b px-3 py-2">
      <Skeleton className="size-4 rounded" />
      {PENDING_TABLE_CELLS.map((cell) => (
        <Skeleton className={cn("h-3", cell.width)} key={cell.key} />
      ))}
    </div>
    {PENDING_TABLE_ROW_KEYS.map((rowKey) => (
      <div
        className="flex items-center gap-4 border-b px-3 py-2.5"
        key={rowKey}
      >
        <Skeleton className="size-4 rounded" />
        {PENDING_TABLE_CELLS.map((cell) => (
          <Skeleton className={cn("h-4", cell.width)} key={cell.key} />
        ))}
      </div>
    ))}
  </div>
);

const PendingKanbanBody = () => (
  <div className="flex gap-3 p-3">
    {PENDING_KANBAN_COLUMN_KEYS.map((columnKey) => (
      <div className="flex w-72 shrink-0 flex-col gap-2" key={columnKey}>
        <Skeleton className="h-5 w-32" />
        {PENDING_KANBAN_CARD_KEYS.map((cardKey) => (
          <Skeleton className="h-20 w-full rounded-lg" key={cardKey} />
        ))}
      </div>
    ))}
  </div>
);

const PendingOverviewBody = () => (
  <div className="grid gap-4 p-4 md:grid-cols-2 lg:grid-cols-4">
    {PENDING_OVERVIEW_CARD_KEYS.map((cardKey) => (
      <Skeleton className="h-28 rounded-xl" key={cardKey} />
    ))}
  </div>
);

const ViewBodySkeleton = ({
  layoutType,
}: {
  layoutType: ViewLayout["type"] | undefined;
}) => {
  if (layoutType === "kanban") {
    return <PendingKanbanBody />;
  }
  if (layoutType === "overview") {
    return <PendingOverviewBody />;
  }
  // table / filesystem / calendar / unknown all fall back to the row list.
  return <PendingTableBody />;
};

// Route-pending shell for the matter data-grid: the view chrome row plus a
// layout-aware body skeleton (rows / kanban columns / overview cards), read
// from the cached view so opening a matter shows its structure, not the logo.
function ViewPendingComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const queryClient = useQueryClient();
  const viewsQueryOptions = viewsOptions(workspaceId);
  const cachedViews = queryClient.getQueryData<WorkspaceView[]>(
    viewsQueryOptions.queryKey,
  );
  const layoutType = (
    cachedViews?.find((view) => view.id === viewId) ?? cachedViews?.at(0)
  )?.layout.type;

  return (
    <>
      <div
        className={cn(
          "flex min-w-0 flex-col border-b px-3 md:flex-row md:items-center md:justify-between",
        )}
      >
        <div className={cn("flex items-center gap-1.5", TOOLBAR_ROW_HEIGHT)}>
          <Skeleton className="h-7 w-24 rounded-md" />
          <Skeleton className="h-7 w-20 rounded-md" />
        </div>
        <div className={cn("flex items-center gap-1.5", TOOLBAR_ROW_HEIGHT)}>
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-7 w-24 rounded-md" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto">
          <ViewBodySkeleton layoutType={layoutType} />
        </div>
      </div>
    </>
  );
}
