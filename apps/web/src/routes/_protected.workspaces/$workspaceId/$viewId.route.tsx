import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { produce } from "immer";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { getViewsActorConfig } from "@stella/rivet/actors/views-actor-config";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import { DefaultPendingComponent } from "@/components/route-components";
import type { Actors } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { createEventHandler, eventHandler } from "@/lib/rivet";
import type { WorkspaceView } from "@/lib/types";
import { EntityPagination } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-pagination";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import {
  ViewsActorProvider,
  useSuspenseViewsActor,
} from "@/routes/_protected.workspaces/$workspaceId/-hooks/views-actor-provider";
import {
  entitiesKeys,
  entitiesOptions,
  useEntitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workflowOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

const searchSchema = v.object({
  folder: v.optional(v.string()),
  page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/$viewId",
)({
  component: RouteComponent,
  validateSearch: searchSchema,
});

const viewsEvent = createEventHandler<Actors["views"]>();

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const { authToken, organizationId } = Route.useRouteContext({
    select: (ctx) => ({
      authToken: ctx.authToken,
      organizationId: ctx.user.activeOrganizationId,
    }),
  });

  const config = getViewsActorConfig({
    type: "react",
    organizationId,
    authToken,
    workspaceId,
  });

  return (
    <ViewsActorProvider config={config} fallback={<DefaultPendingComponent />}>
      <ViewsRoute />
    </ViewsActorProvider>
  );
}

function ViewsRoute() {
  const t = useTranslations();
  const { workspaceId, viewId } = Route.useParams({
    select: (p) => ({ workspaceId: p.workspaceId, viewId: p.viewId }),
  });
  const page = Route.useSearch({
    select: (s) => s.page ?? 1,
  });
  const viewsContext = Route.useRouteContext({
    select: (ctx) => ({
      authToken: ctx.authToken,
      organizationId: ctx.user.activeOrganizationId,
    }),
  });
  const queryClient = useQueryClient();
  const viewsActor = useSuspenseViewsActor();
  const viewsQueryOptions = viewsOptions({
    key: { workspaceId },
    context: viewsContext,
  });
  const { data: activeView } = useSuspenseQuery({
    ...viewsQueryOptions,
    select: (data) => data.find((view) => view.id === viewId) ?? data.at(0),
  });
  useSyncTable({
    workspaceId,
    filters: activeView?.layout.filters ?? [],
    sorts: activeView?.layout.sorts ?? [],
    page,
  });
  const pruneStaleViews = useTableStore((s) => s.pruneStaleViews);
  const workflowActor = useWorkflowActor(workspaceId);

  const workflowQueryKey = workflowOptions({
    workspaceId,
    organizationId: viewsContext.organizationId,
  }).queryKey;

  const invalidateQueries = async () =>
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.byId(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: propertiesKeys.all(workspaceId),
      }),
    ]);

  workflowActor.useEvent(
    ...eventHandler("panic", async () => {
      const isRunning = queryClient.getQueryData(workflowQueryKey)?.running;

      if (!isRunning) {
        return;
      }

      toastManager.add({
        type: "error",
        title: t("workspaces.workflow.terminated"),
        description: t("workspaces.workflow.terminatedDescription"),
      });

      await invalidateQueries();

      queryClient.setQueryData(workflowQueryKey, (old) => ({
        ...old,
        running: false,
      }));
    }),
  );

  workflowActor.useEvent(
    ...eventHandler("workflow-status", async ({ running }) => {
      if (!running) {
        await invalidateQueries();
      }

      queryClient.setQueryData(workflowQueryKey, (old) => ({
        ...old,
        running,
      }));
    }),
  );

  workflowActor.useEvent(
    ...eventHandler("field-content", (fields) => {
      queryClient.setQueryData(
        entitiesOptions({
          workspaceId,
          filters: activeView?.layout.filters ?? [],
          sorts: activeView?.layout.sorts ?? [],
          page,
        }).queryKey,
        (old) =>
          produce(old, (draft) => {
            if (!draft) {
              return;
            }

            for (const field of fields) {
              const entityIndex = draft.entities.findIndex(
                (e) => e.entityId === field.entityId,
              );

              if (entityIndex === -1) {
                continue;
              }

              const entity = draft.entities[entityIndex];
              if (!entity) {
                continue;
              }

              if (field.content === null) {
                Reflect.deleteProperty(entity.fields, field.propertyId);
                continue;
              }

              entity.fields[field.propertyId] = {
                id: field.id,
                entityId: field.entityId,
                content: field.content,
              };
            }
          }),
      );
    }),
  );

  viewsActor.useEvent(
    ...viewsEvent("views-changed", async ({ views: updated }) => {
      pruneStaleViews(updated.map((view) => view.id));
      await queryClient.cancelQueries({
        queryKey: viewsQueryOptions.queryKey,
      });
      queryClient.setQueryData(viewsQueryOptions.queryKey, (prev) => {
        if (!prev) {
          return updated;
        }

        const merged = prev.map(
          (view) => updated.find((u) => u.id === view.id) ?? view,
        );

        for (const view of updated) {
          if (!merged.some((m) => m.id === view.id)) {
            merged.push(view);
          }
        }

        return merged.toSorted((a, b) => a.position - b.position);
      });
    }),
  );

  viewsActor.useEvent(
    ...viewsEvent("view-deleted", async ({ viewId: deletedViewId }) => {
      await queryClient.cancelQueries({
        queryKey: viewsQueryOptions.queryKey,
      });
      queryClient.setQueryData(viewsQueryOptions.queryKey, (prev) =>
        prev?.filter((view) => view.id !== deletedViewId),
      );
    }),
  );

  if (!activeView) {
    return null;
  }

  return (
    <ViewContent
      activeView={activeView}
      page={page}
      workspaceId={workspaceId}
    />
  );
}

type ViewContentProps = {
  activeView: WorkspaceView;
  page: number;
  workspaceId: string;
};

function ViewContent({ activeView, page, workspaceId }: ViewContentProps) {
  const navigate = Route.useNavigate();
  const { filters, sorts } = activeView.layout;

  const { data } = useSuspenseQuery(
    useEntitiesOptions({
      workspaceId,
      filters,
      sorts,
      page,
    }),
  );

  const totalPages = Math.ceil(data.totalCount / data.pageSize);

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
        {totalPages > 1 && activeView.layout.type !== "overview" && (
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
