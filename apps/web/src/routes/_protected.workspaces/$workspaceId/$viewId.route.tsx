import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { produce } from "immer";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { toastManager } from "@stella/ui/components/toast";

import type { Actors } from "@/lib/api";
import { createEventHandler, eventHandler } from "@/lib/rivet";
import type { WorkspaceView } from "@/lib/types";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";
import { EntityPagination } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-pagination";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useViewsActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-views-actor";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import {
  entitiesKeys,
  entitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { propertiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workflowOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";

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
  const t = useTranslations();
  const { workspaceId, viewId } = Route.useParams();
  const page = Route.useSearch({
    select: (s) => s.page ?? 1,
  });
  const organizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const queryClient = useQueryClient();
  const viewsQueryOptions = viewsOptions(workspaceId, queryClient);
  const { data: activeView } = useSuspenseQuery({
    ...viewsQueryOptions,
    select: (data) => data.find((v) => v.id === viewId) ?? data.at(0),
  });
  const viewsActor = useViewsActor(workspaceId);
  const pruneStaleViews = useTableStore((s) => s.pruneStaleViews);
  const workflowActor = useWorkflowActor(workspaceId);

  const workflowQueryKey = workflowOptions({
    workspaceId,
    organizationId,
  }).queryKey;

  const invalidateQueries = () =>
    Promise.all([
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

              if (field.content === null) {
                delete draft.entities[entityIndex].fields[field.propertyId];
                continue;
              }

              draft.entities[entityIndex].fields[field.propertyId] = {
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
      pruneStaleViews(updated.map((v) => v.id));
      await queryClient.cancelQueries({
        queryKey: viewsQueryOptions.queryKey,
      });
      queryClient.setQueryData(viewsQueryOptions.queryKey, (prev) => {
        if (!prev) {
          return updated;
        }

        const merged = prev.map((v) => updated.find((u) => u.id === v.id) ?? v);

        for (const v of updated) {
          if (!merged.some((m) => m.id === v.id)) {
            merged.push(v);
          }
        }

        return merged.sort((a, b) => a.position - b.position);
      });
    }),
  );

  viewsActor.useEvent(
    ...viewsEvent("view-deleted", async ({ viewId }) => {
      await queryClient.cancelQueries({
        queryKey: viewsQueryOptions.queryKey,
      });
      queryClient.setQueryData(viewsQueryOptions.queryKey, (prev) =>
        prev?.filter((v) => v.id !== viewId),
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
    entitiesOptions({ workspaceId, filters, sorts, page }),
  );

  const totalPages = Math.ceil(data.totalCount / data.pageSize);

  const setPage = (newPage: number) => {
    navigate({
      search: (prev) => ({
        ...prev,
        page: newPage === 1 ? undefined : newPage,
      }),
    });
  };

  return (
    <>
      <div className="flex items-center justify-between border-b">
        <ViewSwitcher
          activeViewId={activeView.id}
          onViewChange={async (viewId) => {
            await navigate({
              to: ".",
              params: { workspaceId, viewId },
              search: { page: undefined },
            });
          }}
          workspaceId={workspaceId}
        />
        <ViewToolbar view={activeView} workspaceId={workspaceId} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
        {totalPages > 1 && (
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
