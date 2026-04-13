import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
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
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";
import {
  entitiesOptions,
  useEntitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { timeEntriesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { justificationsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  getWeekStart,
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

    const entities = await ensureCriticalQueryData(
      queryClient,
      entitiesOptions({
        workspaceId,
        filters: activeView.layout.filters,
        sorts: activeView.layout.sorts,
        page: deps.page,
      }),
    );

    if (entities.entities.length === 0) {
      return;
    }

    const entityIds = [
      ...new Set(entities.entities.map((entity) => entity.entityId)),
    ].toSorted();

    void prefetchNonCriticalQuery(
      queryClient,
      justificationsOptions({ workspaceId, entityIds }),
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );
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

function OverviewViewContent({ activeView, workspaceId }: ViewContentProps) {
  return <ViewShell activeView={activeView} workspaceId={workspaceId} />;
}

function EntityViewContent({
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

  const setPage = (newPage: number) => {
    // eslint-disable-next-line typescript/no-floating-promises
    navigate({
      search: (prev) => ({
        ...prev,
        page: newPage === 1 ? undefined : newPage,
      }),
    });
  };

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
              to: ".",
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
