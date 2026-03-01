import { useEffect } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  retainSearchParams,
  useMatch,
} from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { toastManager } from "@stella/ui/components/toast";

import { eventHandler } from "@/lib/rivet";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";
import { DropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/drop-zone";
import { PeekPanel } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-panel";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { ViewSwitcher } from "@/routes/_protected.workspaces/$workspaceId/-components/view-switcher";
import { ViewToolbar } from "@/routes/_protected.workspaces/$workspaceId/-components/view-toolbar";
import { useSyncTable } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-sync-table";
import { useWorkflowActor } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-workflow-actor";
import {
  entitiesKeys,
  entitiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  propertiesKeys,
  propertiesOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import {
  justificationsOptions,
  workflowOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getInternalColId } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const selectColId = getInternalColId("select");
const defaultSearch = {
  view: undefined,
  columnPinning: [selectColId],
  columnSizing: {},
  sorting: [],
  rowSelection: {},
};

const projectSearchSchema = v.object({
  view: v.optional(v.string()),
  folder: v.optional(v.string()),
  columnPinning: v.optional(v.array(v.string()), defaultSearch.columnPinning),
  columnSizing: v.optional(
    v.record(v.string(), v.number()),
    defaultSearch.columnSizing,
  ),
  sorting: v.optional(
    v.array(v.object({ id: v.string(), desc: v.boolean() })),
    defaultSearch.sorting,
  ),
  rowSelection: v.optional(
    v.record(v.string(), v.boolean()),
    defaultSearch.rowSelection,
  ),
});

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  validateSearch: projectSearchSchema,
  component: RouteComponent,
  search: {
    middlewares: [retainSearchParams(true)],
  },
  beforeLoad: async ({ context, params }) => {
    // Prefetch all workspace data in parallel before
    // rendering so the component never suspends (no
    // sidebar flash, no blank screen).
    const wsId = params.workspaceId;
    const qc = context.queryClient;
    await Promise.all([
      qc.ensureQueryData(viewsOptions(wsId)),
      qc.ensureQueryData(entitiesOptions(wsId)),
      qc.ensureQueryData(propertiesOptions(wsId)),
      qc.ensureQueryData(justificationsOptions(wsId)),
    ]);
  },
});

function RouteComponent() {
  const t = useTranslations();
  useSyncTable();
  const organizationId = Route.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });

  // Clean up peek tabs when the workspace changes so stale
  // field IDs from the previous workspace don't cause broken
  // PDF previews.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspaceId triggers cleanup on navigation
  useEffect(() => {
    return () => usePeekStore.getState().closeAll();
  }, [workspaceId]);

  const activeViewId = Route.useSearch({ select: (s) => s.view });
  const navigate = Route.useNavigate();
  const workflowActor = useWorkflowActor(workspaceId);
  const setFieldData = useWorkspaceStore((s) => s.setFieldData);
  const queryClient = useQueryClient();

  const { data: views } = useSuspenseQuery(viewsOptions(workspaceId));

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

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
    ...eventHandler("field-content", (data) => {
      setFieldData(data);
    }),
  );

  const timesheetsMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/timesheets",
    shouldThrow: false,
  });

  const hasPeekTabs = usePeekStore((s) => s.tabs.length > 0);

  // Timesheets has its own layout; skip entity-specific UI
  if (timesheetsMatch) {
    return <Outlet />;
  }

  return (
    <DropZone workspaceId={workspaceId}>
      <div className="flex items-center border-b">
        <ViewSwitcher
          activeViewId={activeView?.id ?? null}
          onViewChange={async (viewId) => {
            await navigate({
              to: "/workspaces/$workspaceId",
              search: (prev) => ({ ...prev, view: viewId }),
            });
          }}
          workspaceId={workspaceId}
        />
        <div className="flex-1" />
        {activeView && (
          <ViewToolbar view={activeView} workspaceId={workspaceId} />
        )}
      </div>
      <Group orientation="horizontal">
        <Panel>
          <Outlet />
        </Panel>
        {hasPeekTabs && (
          <>
            <Separator className="group flex w-1 shrink-0 cursor-col-resize items-center justify-center data-[separator=active]:bg-border data-[separator=hover]:bg-border">
              <div className="h-8 w-0.5 rounded-full bg-border group-data-[separator=active]:hidden group-data-[separator=hover]:hidden" />
            </Separator>
            <Panel defaultSize="32rem" maxSize="50rem" minSize="20rem">
              <PeekPanel workspaceId={workspaceId} />
            </Panel>
          </>
        )}
      </Group>
    </DropZone>
  );
}
