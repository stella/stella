import { lazy, Suspense } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { loadCallerFeature } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import type { ViewLayout, ViewLayoutType, WorkspaceView } from "@/lib/types";
import {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  overviewActivityOptions,
  overviewOptions,
} from "@/lib/workspaces/queries";
import {
  correspondenceAddressOptions,
  correspondenceInfiniteOptions,
  CORRESPONDENCE_PAGE_SIZE,
} from "@/lib/workspaces/queries/correspondence";
import {
  filesystemEntitiesOptions,
  visibleEntityFieldIds,
  workspaceFilesOptions,
} from "@/lib/workspaces/queries/entities";
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceView } from "@/lib/workspaces/queries/views.logic";
import { isAvtView, isTableView } from "@/lib/workspaces/view-layout";
import { CalendarView } from "@/routes/_protected.workspaces/$workspaceId/-components/calendar/calendar-view";
import { CorrespondenceView } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view";
import { FilesystemView } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view";
import { KanbanView } from "@/routes/_protected.workspaces/$workspaceId/-components/kanban/kanban-view";
import { OverviewView } from "@/routes/_protected.workspaces/$workspaceId/-components/overview-view";
import { TableLayout } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-layout";

// The AVT view loads only after caller feature admission.
const AvtRoute = lazy(async () => {
  const m = await import("@/features/avt/avt-route");
  return { default: m.AvtRoute };
});

type FilesystemWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "filesystem" }>;
};

type CalendarWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "calendar" }>;
};

const isFilesystemView = (
  view: WorkspaceView,
): view is FilesystemWorkspaceView => view.layout.type === "filesystem";

const isCalendarView = (view: WorkspaceView): view is CalendarWorkspaceView =>
  view.layout.type === "calendar";

// `run` opens one verification in an AVT view.
const searchSchema = v.object({
  run: optionalSearchStringSchema(),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/",
)({
  component: RouteComponent,
  validateSearch: searchSchema,
  loader: async ({ context, params }) => {
    const { queryClient } = context;
    const { workspaceId, viewId } = params;

    const views = await ensureRouteQueryData(
      queryClient,
      viewsOptions(workspaceId),
    );
    const activeView = views.find((view) => view.id === viewId) ?? views.at(0);

    if (!activeView) {
      return;
    }

    // FilesystemView, KanbanView, OverviewView, and TableLayout each suspend
    // on their own query below, but the switch in RouteComponent renders
    // exactly one of them, chosen by the server-returned view type. This map
    // references every one of those factories — so require-loader-prefetch's
    // colocated-import check (which sees all four suspense calls but not
    // which one actually renders) is satisfied — while only invoking the
    // branch matching activeView.layout.type, so a cold navigation warms
    // exactly the query the rendered view needs.
    const prefetchByViewType: Record<ViewLayoutType, () => Promise<void>> = {
      table: async () => {
        await ensureRouteQueryData(queryClient, propertiesOptions(workspaceId));
      },
      kanban: async () => {
        await ensureRouteQueryData(queryClient, propertiesOptions(workspaceId));
      },
      overview: async () => {
        await Promise.all([
          ensureRouteQueryData(queryClient, overviewOptions(workspaceId)),
          ensureRouteInfiniteQueryData(
            queryClient,
            overviewActivityOptions({
              activeOrganizationId: context.user.activeOrganizationId,
              filters: DEFAULT_MATTER_ACTIVITY_FILTERS,
              workspaceId,
            }),
          ),
        ]);
      },
      filesystem: async () => {
        if (!isFilesystemView(activeView)) {
          return;
        }
        const properties = await ensureRouteQueryData(
          queryClient,
          propertiesOptions(workspaceId),
        );
        const fieldIds = visibleEntityFieldIds({
          hiddenProperties: activeView.layout.hiddenProperties,
          properties,
        });
        await ensureRouteQueryData(
          queryClient,
          filesystemEntitiesOptions({
            workspaceId,
            filters: activeView.layout.filters,
            sorts: activeView.layout.sorts,
            fieldMode: "visible",
            fieldIds,
          }),
        );
      },
      calendar: async () => {
        // CalendarView has no suspense query of its own.
      },
      timeline: async () => {
        // Not yet implemented — RouteComponent renders null.
      },
      avt: async () => {
        const admission = await loadCallerFeature({
          queryClient,
          principal: {
            organizationId: context.user.activeOrganizationId,
            userId: context.user.id,
          },
          feature: CALLER_FEATURE.verification,
          load: async () => {
            await Promise.all([
              ensureRouteQueryData(queryClient, legalListsOptions(workspaceId)),
              ensureRouteQueryData(
                queryClient,
                workspaceFilesOptions(workspaceId),
              ),
            ]);
          },
        });
        if (admission.isErr()) {
          notFound({ throw: true });
        }
      },
      correspondence: async () => {
        // The list suspends on its first page; the address card reads its
        // query without suspending, so a failed prefetch only reports.
        await Promise.all([
          ensureRouteInfiniteQueryData(
            queryClient,
            correspondenceInfiniteOptions(
              workspaceId,
              CORRESPONDENCE_PAGE_SIZE,
            ),
          ),
          prefetchRouteQuery(
            queryClient,
            correspondenceAddressOptions(workspaceId),
            (error: unknown) => {
              getAnalytics().captureError(error);
            },
          ),
        ]);
      },
    };

    await prefetchByViewType[activeView.layout.type]();
  },
});

function RouteComponent() {
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const runId = Route.useSearch({ select: (search) => search.run });
  const navigate = Route.useNavigate();
  const { data: activeView } = useSuspenseQuery({
    ...viewsOptions(workspaceId),
    select: (data) => selectAvailableWorkspaceView(data, viewId),
  });

  if (!activeView) {
    return null;
  }

  switch (activeView.layout.type) {
    case "table":
      if (!isTableView(activeView)) {
        return null;
      }
      return <TableLayout view={activeView} workspaceId={workspaceId} />;
    case "overview":
      return <OverviewView workspaceId={workspaceId} />;
    case "filesystem":
      if (!isFilesystemView(activeView)) {
        return null;
      }
      return <FilesystemView view={activeView} workspaceId={workspaceId} />;
    case "kanban":
      return <KanbanView view={activeView} workspaceId={workspaceId} />;
    case "calendar":
      if (!isCalendarView(activeView)) {
        return null;
      }
      return <CalendarView view={activeView} workspaceId={workspaceId} />;
    case "timeline":
      return null;
    case "avt":
      if (!isAvtView(activeView)) {
        return null;
      }
      return (
        <Suspense fallback={null}>
          <AvtRoute
            onRunChange={(run) => {
              detached(navigate({ search: { run } }), "avt-view.open-run");
            }}
            runId={runId}
            view={activeView}
            workspaceId={workspaceId}
          />
        </Suspense>
      );
    case "correspondence":
      return <CorrespondenceView workspaceId={workspaceId} />;
    default: {
      activeView.layout satisfies never;
      return panic(`Unhandled view layout: ${String(activeView.layout)}`);
    }
  }
}
