import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Skeleton } from "@stll/ui/skeleton";

import { workflowsRouteAvailable } from "@/hooks/use-workflows-preview";
import { flowRunsOptions } from "@/lib/workspaces/queries/flow-runs";
import { RunDetail } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/run-detail";
import { RunLauncher } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/run-launcher";
import { RunsList } from "@/routes/_protected.workspaces/$workspaceId/-components/flows/runs-list";

/**
 * `run` opens one run's detail on arrival: the task a review gate raised and
 * the notification bell both land here with the run they are about.
 */
const workflowsSearchSchema = v.object({
  run: v.optional(v.string()),
});

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/workflows",
)({
  validateSearch: workflowsSearchSchema,
  beforeLoad: ({ params }) => {
    if (!workflowsRouteAvailable()) {
      throw redirect({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: params.workspaceId },
      });
    }
  },
  component: WorkflowsPage,
});

const protectedRouteApi = getRouteApi("/_protected");

type View = { kind: "list" } | { kind: "detail"; runId: string };

const RUN_ROW_KEYS = ["a", "b", "c", "d"];

const RunsSkeleton = () => (
  <div className="flex flex-col gap-1.5 rounded-lg border p-2">
    {RUN_ROW_KEYS.map((key) => (
      <div className="flex items-center gap-3 px-2 py-2" key={key}>
        <Skeleton className="h-5 w-16 rounded-md" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
    ))}
  </div>
);

function WorkflowsPage() {
  const workspaceId = Route.useParams({ select: (p) => p.workspaceId });
  const requestedRunId = Route.useSearch({ select: (s) => s.run });
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
  const t = useTranslations();
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [view, setView] = useState<View>(
    requestedRunId === undefined
      ? { kind: "list" }
      : { kind: "detail", runId: requestedRunId },
  );

  const { data, isPending } = useQuery(flowRunsOptions({ workspaceId }));

  if (view.kind === "detail") {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <RunDetail
          onBack={() => setView({ kind: "list" })}
          runId={view.runId}
          workspaceId={workspaceId}
        />
      </div>
    );
  }

  const runs = data && "items" in data ? data.items : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("common.workflows")}</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{t("flows.runs.launch")}</h2>
            <RunLauncher
              onStarted={(runId) => setView({ kind: "detail", runId })}
              organizationId={organizationId}
              workspaceId={workspaceId}
            />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{t("flows.runs.history")}</h2>
            {isPending ? (
              <RunsSkeleton />
            ) : (
              <RunsList
                onSelect={(runId) => setView({ kind: "detail", runId })}
                runs={runs}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
