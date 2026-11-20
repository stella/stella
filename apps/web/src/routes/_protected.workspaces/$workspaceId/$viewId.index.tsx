import { createFileRoute, notFound } from "@tanstack/react-router";
import * as v from "valibot";

import { AVT_MODES } from "@/features/avt/avt-mode";
import { getAnalytics } from "@/lib/analytics/provider";
import { loadCallerFeature } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { optionalSearchStringSchema } from "@/lib/schema";
import type { ViewLayoutType } from "@/lib/types";
import {
  DEFAULT_MATTER_ACTIVITY_FILTERS,
  overviewActivityOptions,
  overviewOptions,
} from "@/lib/workspaces/queries";
import {
  CORRESPONDENCE_PAGE_SIZE,
  correspondenceAddressOptions,
  correspondenceInfiniteOptions,
} from "@/lib/workspaces/queries/correspondence";
import {
  filesystemEntitiesOptions,
  visibleEntityFieldIds,
  workspaceFilesOptions,
} from "@/lib/workspaces/queries/entities";
import { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { isFilesystemView } from "@/lib/workspaces/view-layout";
import { routeSearchSchema } from "@/route-search-params";
import { VIEW_SWITCH_PENDING } from "@/routes/-pending-view.logic";
import { routePresentation } from "@/routes/-route-presentation";

import { ViewIndexPage } from "./-$viewId.index.page";
import { ViewIndexPending } from "./-$viewId.index.pending";

// `run` opens one verification in an AVT view; `mode` shows the list as a
// graph or a chronology instead of its review.
const searchSchema = routeSearchSchema({
  run: optionalSearchStringSchema(),
  mode: v.fallback(v.optional(v.picklist(AVT_MODES)), undefined),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId/",
)({
  staticData: { presentation: routePresentation({ type: "inherit" }) },
  component: ViewIndexPage,
  pendingComponent: ViewIndexPending,
  pendingMs: VIEW_SWITCH_PENDING.pendingMs,
  pendingMinMs: VIEW_SWITCH_PENDING.pendingMinMs,
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
    // on their own query below, but the page (`ViewIndexPage`) renders
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
          ensureRouteQueryData(
            queryClient,
            overviewOptions({
              workspaceId,
              organizationId: context.user.activeOrganizationId,
            }),
          ),
          ensureRouteInfiniteQueryData(
            queryClient,
            overviewActivityOptions({
              viewer: {
                userId: context.user.id,
                organizationId: context.user.activeOrganizationId,
              },
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
              getAnalytics().captureError(error, {
                fingerprintKey: "loader.correspondence:failure",
                scope: {
                  type: "request",
                  method: "GET",
                  routeTemplate: "/_protected/workspaces/$workspaceId/$viewId/",
                },
              });
            },
          ),
        ]);
      },
    };

    await prefetchByViewType[activeView.layout.type]();
  },
});
