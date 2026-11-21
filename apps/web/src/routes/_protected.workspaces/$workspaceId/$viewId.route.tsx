import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  getWeekStart,
  resolveKanbanGroupBy,
  toISODate,
} from "@/components/workspaces/entity-utils";
import { windowIncludesAssignees } from "@/components/workspaces/kanban/kanban-view.logic";
import { resolveEntityFind } from "@/components/workspaces/table/entity-find.logic";
import { UNRESTRICTED_FIND } from "@/components/workspaces/table/table-find.logic";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getFormattingLocale } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { loadRouteResource } from "@/lib/errors/route-resource";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
  prefetchRouteQuery,
} from "@/lib/react-query";
import {
  optionalIntegerSearchSchema,
  optionalSearchStringSchema,
} from "@/lib/schema";
import type { EntityKind } from "@/lib/types";
import { overviewOptions } from "@/lib/workspaces/queries";
import {
  CORRESPONDENCE_PAGE_SIZE,
  correspondenceAddressOptions,
  correspondenceInfiniteOptions,
} from "@/lib/workspaces/queries/correspondence";
import {
  DEFAULT_ENTITY_WINDOW_SIZE,
  entitiesWindowOptions,
  filesystemEntitiesOptions,
  visibleEntityFieldIds,
} from "@/lib/workspaces/queries/entities";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import {
  timeEntrySummaryOptions,
  timeEntryTeamSummaryOptions,
} from "@/lib/workspaces/queries/time-entries";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { selectAvailableWorkspaceView } from "@/lib/workspaces/queries/views.logic";
import { useTableStore } from "@/lib/workspaces/table-store";
import {
  type CurrentWorkspaceDocument,
  getCurrentWorkspaceDocument,
} from "@/lib/workspaces/use-workspace-view-params";
import {
  DEFAULT_WORKSPACE_VIEW_ID,
  isWorkspaceViewId,
  workspaceViewRouteIds,
  workspaceViewsInclude,
} from "@/lib/workspaces/view-params.logic";
import { routeSearchSchema } from "@/route-search-params";
import { VIEW_SWITCH_PENDING } from "@/routes/-pending-view.logic";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";

import { ViewPage } from "./-$viewId.route.page";
import { ViewPending } from "./-$viewId.route.pending";

// v.object: validateSearch receives the full URL search params
// including params from child routes; strictObject would reject them.
const searchSchema = routeSearchSchema({
  folder: optionalSearchStringSchema(),
  reveal: optionalSearchStringSchema(),
  page: optionalIntegerSearchSchema({ min: 1 }),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId",
)({
  component: ViewPage,
  pendingComponent: ViewPending,
  pendingMs: VIEW_SWITCH_PENDING.pendingMs,
  pendingMinMs: VIEW_SWITCH_PENDING.pendingMinMs,
  validateSearch: searchSchema,
  // Annotated: the context this returns is part of the `matches` type it
  // reads, so an inferred return would be circular.
  beforeLoad: ({
    matches,
    params,
  }): { documentOnScreen: CurrentWorkspaceDocument } => {
    // Reject obviously invalid viewIds (e.g. "workspaces" from stale doubled
    // URLs).
    if (!isWorkspaceViewId(params.viewId)) {
      if (import.meta.env.DEV) {
        // oxlint-disable-next-line no-console -- dev-only stack trace to debug stale doubled URLs
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
    // The loader sees no matches; the document page below this view is read
    // from them here.
    return { documentOnScreen: getCurrentWorkspaceDocument(matches) };
  },
  loader: async ({ context, params }) => {
    const { workspaceId, viewId } = params;
    const { queryClient } = context;
    const isDocumentRoute = context.documentOnScreen !== undefined;

    const views = await loadRouteResource({
      ids: workspaceViewRouteIds(workspaceId, viewId),
      load: async () =>
        await ensureRouteQueryData(queryClient, viewsOptions(workspaceId)),
      exists: (loadedViews) => workspaceViewsInclude(loadedViews, viewId),
    });
    const activeView =
      viewId === DEFAULT_WORKSPACE_VIEW_ID
        ? selectAvailableWorkspaceView(views, viewId)
        : views.find((view) => view.id === viewId);

    if (!activeView) {
      return;
    }

    if (activeView.layout.type === "overview") {
      if (isDocumentRoute) {
        return;
      }

      await ensureRouteQueryData(
        queryClient,
        overviewOptions({
          workspaceId,
          organizationId: context.user.activeOrganizationId,
        }),
      );

      if (
        !(await isTimeBillingRouteEnabled(queryClient, {
          userId: context.user.id,
          organizationId: context.user.activeOrganizationId,
        }))
      ) {
        return;
      }

      const role = await ensureRouteQueryData(queryClient, roleOptions);
      const canReadTimeEntries = authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["read"] },
      });
      if (!canReadTimeEntries) {
        return;
      }
      const canReviewTimeEntries = authClient.organization.checkRolePermission({
        role,
        permissions: { timeEntry: ["approve"] },
      });

      const weekStart = getWeekStart(getFormattingLocale());
      const weekEnd = weekStart.add({ days: 6 });
      const prevWeekStart = weekStart.subtract({ days: 7 });
      const prevWeekEnd = weekStart.subtract({ days: 1 });

      if (canReviewTimeEntries) {
        detached(
          prefetchRouteQuery(
            queryClient,
            timeEntryTeamSummaryOptions(
              workspaceId,
              context.user.id,
              toISODate(weekStart),
              toISODate(weekEnd),
            ),
            (error: unknown) => {
              getAnalytics().captureError(error, {
                fingerprintKey:
                  "workspaces.workspaceId.viewId.route.loader:failure",
                scope: {
                  type: "request",
                  method: "GET",
                  routeTemplate: "/_protected/workspaces/$workspaceId/$viewId",
                },
              });
            },
          ),
          "workspace-view.prefetch",
        );
      } else {
        detached(
          prefetchRouteQuery(
            queryClient,
            timeEntrySummaryOptions(
              workspaceId,
              context.user.id,
              toISODate(weekStart),
              toISODate(weekEnd),
            ),
            (error: unknown) => {
              getAnalytics().captureError(error, {
                fingerprintKey:
                  "workspaces.workspaceId.viewId.route.loader:failure-2",
                scope: {
                  type: "request",
                  method: "GET",
                  routeTemplate: "/_protected/workspaces/$workspaceId/$viewId",
                },
              });
            },
          ),
          "workspace-view.prefetch",
        );
      }
      detached(
        prefetchRouteQuery(
          queryClient,
          timeEntrySummaryOptions(
            workspaceId,
            context.user.id,
            toISODate(prevWeekStart),
            toISODate(prevWeekEnd),
          ),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.route.loader:failure-3",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate: "/_protected/workspaces/$workspaceId/$viewId",
              },
            });
          },
        ),
        "workspace-view.prefetch",
      );
      return;
    }

    if (activeView.layout.type === "correspondence") {
      if (isDocumentRoute) {
        return;
      }
      // The list suspends on its first page; the address card reads its
      // query without suspending, so a failed prefetch only reports.
      await Promise.all([
        ensureRouteInfiniteQueryData(
          queryClient,
          correspondenceInfiniteOptions(workspaceId, CORRESPONDENCE_PAGE_SIZE),
        ),
        prefetchRouteQuery(
          queryClient,
          correspondenceAddressOptions(workspaceId),
          (error: unknown) => {
            getAnalytics().captureError(error, {
              fingerprintKey:
                "workspaces.workspaceId.viewId.route.loader:failure-4",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate: "/_protected/workspaces/$workspaceId/$viewId",
              },
            });
          },
        ),
      ]);
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
            ...(activeView.layout.subgroupByPropertyId
              ? [activeView.layout.subgroupByPropertyId]
              : []),
          ]
        : [];
    const shouldLoadVisibleFields =
      activeView.layout.type === "filesystem" ||
      activeView.layout.type === "table" ||
      (activeView.layout.type === "kanban" &&
        activeView.layout.subgroupByPropertyId !== undefined);
    const fieldIds = shouldLoadVisibleFields
      ? visibleEntityFieldIds({
          hiddenProperties: activeView.layout.hiddenProperties,
          properties,
          requiredPropertyIds,
        })
      : [];
    const fieldMode = shouldLoadVisibleFields ? "visible" : "full";

    if (activeView.layout.type === "table") {
      const excludedKinds: EntityKind[] = includesListItems(
        activeView.layout.filters,
      )
        ? ["folder"]
        : ["folder", "task"];
      // A live find is part of the window's key: without it the layout would
      // suspend a second time on the window it actually reads.
      const find = useTableStore.getState().find[workspaceId]?.[activeView.id];
      const { request } = resolveEntityFind({
        hasNameColumn: includesListItems(activeView.layout.filters),
        hiddenProperties: activeView.layout.hiddenProperties,
        properties,
        selection: find?.scope ?? UNRESTRICTED_FIND,
        term: find?.submitted ?? "",
      });
      await ensureRouteInfiniteQueryData(
        queryClient,
        entitiesWindowOptions({
          workspaceId,
          filters: activeView.layout.filters,
          sorts: activeView.layout.sorts,
          limit: DEFAULT_ENTITY_WINDOW_SIZE,
          excludedKinds,
          fieldMode,
          fieldIds,
          ...request,
        }),
      );
      return;
    }

    if (
      activeView.layout.type === "kanban" &&
      activeView.layout.subgroupByPropertyId !== undefined
    ) {
      await ensureRouteInfiniteQueryData(
        queryClient,
        entitiesWindowOptions({
          workspaceId,
          filters: activeView.layout.filters,
          sorts: activeView.layout.sorts,
          limit: DEFAULT_ENTITY_WINDOW_SIZE,
          fieldMode,
          fieldIds,
          // Same derivation the kanban board's own window query uses, so a
          // preloaded assignee-subgroup board's request matches this
          // preload's cache key and never discards it for a refetch.
          includeAssignees: windowIncludesAssignees(activeView),
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
