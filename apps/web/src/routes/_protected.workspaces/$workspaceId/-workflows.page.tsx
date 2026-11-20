import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { flowRunsOptions } from "@/lib/workspaces/queries/flow-runs";
import { RunDetail } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/run-detail";
import { RunLauncher } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/run-launcher";
import { RunsList } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/runs-list";

import { RunDetailShell } from "./-components/flows/run-detail.pending";
import { RunsSkeleton } from "./-components/flows/runs-list.pending";
import { WorkflowsShell } from "./-workflows.pending";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/workflows");

const protectedRouteApi = getRouteApi("/_protected");

type View = { kind: "list" } | { kind: "detail"; runId: string };

export function WorkflowsPage() {
  const workspaceId = routeApi.useParams({ select: (p) => p.workspaceId });
  const requestedRunId = routeApi.useSearch({ select: (s) => s.run });
  // Key on the matter so navigating directly between two matters' Workflows
  // pages remounts the view: TanStack reuses this route instance across a
  // param change, which would otherwise keep the previous matter's run-detail
  // state (a `runId` from matter A requested under matter B → load failure).
  return (
    <WorkflowsView
      key={workspaceId}
      requestedRunId={requestedRunId}
      workspaceId={workspaceId}
    />
  );
}

function WorkflowsView({
  workspaceId,
  requestedRunId,
}: {
  workspaceId: string;
  requestedRunId: string | undefined;
}) {
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const navigate = routeApi.useNavigate();
  const openRun = (runId: string) => {
    detached(navigate({ search: { run: runId } }), "workflows.open-run");
  };
  const view: View =
    requestedRunId === undefined
      ? { kind: "list" }
      : { kind: "detail", runId: requestedRunId };

  const dataQuery = useQuery(flowRunsOptions({ workspaceId }));
  const { isPending } = dataQuery;
  const dataView = queryView(dataQuery, {
    isEmpty: (data) => "items" in data && data.items.length === 0,
  });
  const data = dataView.type === "items" ? dataView.items : undefined;

  if (dataView.type === "error" && view.kind === "list") {
    return <QueryViewFeedback view={dataView} />;
  }

  if (view.kind === "detail") {
    return (
      <RunDetailShell>
        <RunDetail
          onBack={() => {
            detached(navigate({ search: {} }), "workflows.back-to-list");
          }}
          runId={view.runId}
          workspaceId={workspaceId}
        />
      </RunDetailShell>
    );
  }

  const runs = data && "items" in data ? data.items : [];

  return (
    <WorkflowsShell
      feedback={
        dataView.type !== "pending" && <QueryViewFeedback view={dataView} />
      }
      launcher={
        <RunLauncher
          onStarted={openRun}
          organizationId={organizationId}
          workspaceId={workspaceId}
        />
      }
      history={
        isPending ? (
          <RunsSkeleton />
        ) : (
          <RunsList onSelect={openRun} runs={runs} />
        )
      }
    />
  );
}
