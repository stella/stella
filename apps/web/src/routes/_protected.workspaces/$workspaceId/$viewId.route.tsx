import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatches,
} from "@tanstack/react-router";
import * as v from "valibot";

import { cn } from "@stella/ui/lib/utils";

import { getAnalytics } from "@/lib/analytics/provider";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import {
  ensureCriticalQueryData,
  prefetchNonCriticalQuery,
} from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import type { WorkspaceView } from "@/lib/types";
import { EntityPagination } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-pagination";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";
import { chunkJustificationEntityIds } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-justifications";
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";
import {
  entitiesOptions,
  entitiesWindowOptions,
  useEntitiesOptions,
  visibleEntityFieldIds,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  getWeekStart,
  resolveKanbanGroupBy,
  toISODate,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

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
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  beforeLoad: ({ params }) => {
    // Reject obviously invalid viewIds (e.g. "workspaces" from stale doubled
    // URLs). Allow UUIDs and the special "all" slug used by the PDF viewer.
    const VALID_VIEW_ID =
      /^(?:all|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
    if (!VALID_VIEW_ID.test(params.viewId)) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.trace(
          `[stella] beforeLoad rejected viewId="${params.viewId}" — redirecting. URL:`,
          globalThis.location?.href,
        );
      }
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
        replace: true,
      });
    }
  },
  loader: async ({ context, deps, params }) => {
    const { workspaceId, viewId } = params;
    const { queryClient } = context;

    const views = await ensureCriticalQueryData(
      queryClient,
      viewsOptions(workspaceId),
    );
    const activeView = views.find((view) => view.id === viewId) ?? views.at(0);

    if (!activeView) {
      return;
    }

    if (activeView.layout.type === "overview") {
      const weekStart = getWeekStart();
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const prevWeekStart = new Date(weekStart);
      prevWeekStart.setDate(prevWeekStart.getDate() - 7);
      const prevWeekEnd = new Date(weekStart);
      prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);

      void prefetchNonCriticalQuery(
        queryClient,
        timeEntriesOptions(workspaceId, {
          dateFrom: toISODate(weekStart),
          dateTo: toISODate(weekEnd),
        }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
      void prefetchNonCriticalQuery(
        queryClient,
        timeEntriesOptions(workspaceId, {
          dateFrom: toISODate(prevWeekStart),
          dateTo: toISODate(prevWeekEnd),
        }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
      void prefetchNonCriticalQuery(
        queryClient,
        workspaceMembersOptions(workspaceId),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
      return;
    }

    const shouldLoadViewProperties =
      activeView.layout.type === "filesystem" ||
      activeView.layout.type === "table" ||
      activeView.layout.type === "kanban";
    const properties = shouldLoadViewProperties
      ? await ensureCriticalQueryData(
          queryClient,
          propertiesOptions(workspaceId),
        )
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
      activeView.layout.type === "table" ||
      activeView.layout.type === "kanban";
    const fieldIds = shouldLoadVisibleFields
      ? visibleEntityFieldIds({
          hiddenProperties: activeView.layout.hiddenProperties,
          properties,
          requiredPropertyIds,
        })
      : [];
    const fieldMode = shouldLoadVisibleFields ? "visible" : "full";

    if (activeView.layout.type === "table") {
      await queryClient.ensureInfiniteQueryData(
        entitiesWindowOptions({
          workspaceId,
          filters: activeView.layout.filters,
          sorts: activeView.layout.sorts,
          limit: 200,
          excludedKinds: ["folder", "task"],
          fieldMode,
          fieldIds,
        }),
      );
      return;
    }

    const entities = await ensureCriticalQueryData(
      queryClient,
      entitiesOptions({
        workspaceId,
        filters: activeView.layout.filters,
        sorts: activeView.layout.sorts,
        page: deps.page,
        fieldMode,
        fieldIds,
      }),
    );

    if (entities.entities.length === 0) {
      return;
    }

    if (activeView.layout.type === "filesystem") {
      return;
    }

    for (const entityIds of chunkJustificationEntityIds(
      entities.entities.map((entity) => entity.entityId),
    )) {
      void prefetchNonCriticalQuery(
        queryClient,
        justificationsOptions({ workspaceId, entityIds }),
        (error: unknown) => {
          getAnalytics().captureError(error);
        },
      );
    }
  },
});

function RouteComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const page = Route.useSearch({
    select: (s) => s.page ?? 1,
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
    <EntityViewContent
      activeView={activeView}
      page={page}
      workspaceId={workspaceId}
    />
  );
}

type ViewContentProps = {
  activeView: WorkspaceView;
  workspaceId: string;
};

type EntityViewContentProps = ViewContentProps & {
  page: number;
};

type VisibleFieldsView = WorkspaceView & {
  layout: Extract<WorkspaceView["layout"], { type: "filesystem" | "kanban" }>;
};

function OverviewViewContent({ activeView, workspaceId }: ViewContentProps) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function EntityViewContent({
  activeView,
  page,
  workspaceId,
}: EntityViewContentProps) {
  if (hasVisibleFieldsLayout(activeView)) {
    return (
      <VisibleFieldEntityViewContent
        activeView={activeView}
        page={page}
        workspaceId={workspaceId}
      />
    );
  }

  if (activeView.layout.type === "table") {
    return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
  }

  return (
    <FullEntityViewContent
      activeView={activeView}
      page={page}
      workspaceId={workspaceId}
    />
  );
}

const hasVisibleFieldsLayout = (
  view: WorkspaceView,
): view is VisibleFieldsView =>
  view.layout.type === "filesystem" || view.layout.type === "kanban";

function VisibleFieldEntityViewContent({
  activeView,
  page,
  workspaceId,
}: EntityViewContentProps & { activeView: VisibleFieldsView }) {
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const requiredPropertyIds =
    activeView.layout.type === "kanban"
      ? [
          resolveKanbanGroupBy(
            activeView.layout.groupByPropertyId ?? "",
            properties,
          ),
        ]
      : [];
  const fieldIds = visibleEntityFieldIds({
    hiddenProperties: activeView.layout.hiddenProperties,
    properties,
    requiredPropertyIds,
  });

  useSyncTable({
    workspaceId,
    filters: activeView.layout.filters ?? [],
    sorts: activeView.layout.sorts ?? [],
    page,
    fieldMode: "visible",
    fieldIds,
  });

  const { data } = useSuspenseQuery(
    useEntitiesOptions({
      workspaceId,
      filters: activeView.layout.filters,
      sorts: activeView.layout.sorts,
      page,
      fieldMode: "visible",
      fieldIds,
    }),
  );
  const totalPages = Math.ceil(data.totalCount / data.pageSize);

  return (
    <ViewShell
      activeView={activeView}
      page={page}
      totalPages={totalPages}
      workspaceId={workspaceId}
    />
  );
}

function FullEntityViewContent({
  activeView,
  page,
  workspaceId,
}: EntityViewContentProps) {
  useSyncTable({
    workspaceId,
    filters: activeView.layout.filters ?? [],
    sorts: activeView.layout.sorts ?? [],
    page,
  });

  const { data } = useSuspenseQuery(
    useEntitiesOptions({
      workspaceId,
      filters: activeView.layout.filters,
      sorts: activeView.layout.sorts,
      page,
    }),
  );
  const totalPages = Math.ceil(data.totalCount / data.pageSize);

  return (
    <ViewShell
      activeView={activeView}
      page={page}
      totalPages={totalPages}
      workspaceId={workspaceId}
    />
  );
}

type ViewShellProps = ViewContentProps & {
  page?: number;
  totalPages?: number;
};

function ViewShell({
  activeView,
  page,
  totalPages,
  workspaceId,
}: ViewShellProps) {
  const navigate = Route.useNavigate();
  const matches = useMatches();
  const isOnPdfRoute = matches.some((m) => m.fullPath.endsWith("/pdf"));

  const setPage = (newPage: number) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      search: (prev) => ({
        ...prev,
        page: newPage === 1 ? undefined : newPage,
      }),
    });
  };

  // File detail view: hide ViewSwitcher + pagination; breadcrumbs
  // provide navigation back to the matter.
  if (isOnPdfRoute) {
    return <Outlet />;
  }

  return (
    <>
      <div
        className={cn(
          "flex min-w-0 items-center justify-between border-b",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <ViewSwitcher
          activeViewId={activeView.id}
          // eslint-disable-next-line typescript/no-misused-promises
          onViewChange={async (viewId) => {
            await navigate({
              to: "/workspaces/$workspaceId/$viewId",
              params: { workspaceId, viewId },
              search: { page: undefined },
            });
          }}
          workspaceId={workspaceId}
        />
        {activeView.layout.type !== "overview" && (
          <ViewToolbar view={activeView} workspaceId={workspaceId} />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
        {page !== undefined && totalPages !== undefined && totalPages > 1 && (
          <EntityPagination
            onPageChange={setPage}
            page={page}
            totalPages={totalPages}
          />
        )}
      </div>
    </>
  );
}
