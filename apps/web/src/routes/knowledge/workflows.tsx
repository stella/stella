import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { workflowsRouteAvailable } from "@/hooks/use-workflows-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  FLOW_PICKER_LIMIT,
  flowDetailOptions,
  flowsOptions,
  knowledgeKeys,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { loadAuthContext } from "@/routes/-auth-context";
import { FlowEditor } from "@/routes/knowledge/-components/flow-editor";
import type { FlowExampleKey } from "@/routes/knowledge/-components/flow-examples";
import { FlowList } from "@/routes/knowledge/-components/flow-list";
import type {
  FlowDefinitionBody,
  FlowDefinitionDetail,
  FlowListItem,
} from "@/routes/knowledge/-components/flow-types";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";

type View =
  | { kind: "list" }
  | { kind: "editor"; flowId: string | null; example?: FlowExampleKey };

export const Route = createFileRoute("/knowledge/workflows")({
  beforeLoad: async ({ context }) => {
    const auth =
      context.user === undefined
        ? await loadAuthContext(context.queryClient)
        : null;
    const userId = context.user?.id ?? auth?.session?.userId;
    const organizationId =
      context.user?.activeOrganizationId ?? auth?.session?.activeOrganizationId;
    if (
      !userId ||
      !organizationId ||
      !(await workflowsRouteAvailable(context.queryClient, {
        userId,
        organizationId,
      }))
    ) {
      throw redirect({ to: "/knowledge" });
    }
  },
  component: GuardedWorkflowsPage,
});

const FLOW_ROW_KEYS = ["a", "b", "c", "d", "e"];

// The GET response carries workspace ids as plain strings; the PUT body
// expects branded SafeIds, so rebrand before sending a fetched trigger back.
const toTriggerBody = (
  trigger: FlowDefinitionDetail["trigger"],
): FlowDefinitionBody["trigger"] => {
  if (trigger.type === "schedule") {
    const { dayOfWeek, dayOfMonth, frequency, hourUtc } = trigger.schedule;
    return {
      type: "schedule",
      workspaceId: toSafeId<"workspace">(trigger.workspaceId),
      // The fetched trigger types the day fields as `number | undefined`; under
      // exactOptionalPropertyTypes the body wants them absent, not `undefined`,
      // so re-add each only when it has a value.
      schedule: {
        frequency,
        hourUtc,
        ...(dayOfWeek === undefined ? {} : { dayOfWeek }),
        ...(dayOfMonth === undefined ? {} : { dayOfMonth }),
      },
    };
  }
  if (trigger.type === "file-upload") {
    return {
      ...trigger,
      workspaceIds:
        trigger.workspaceIds === null
          ? null
          : trigger.workspaceIds.map((id) => toSafeId<"workspace">(id)),
    };
  }
  return trigger;
};

function WorkflowsPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
      <ul className="flex-1 divide-y overflow-y-auto">
        {FLOW_ROW_KEYS.map((key) => (
          <li className="flex items-center gap-3 px-4 py-3" key={key}>
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const organizationId = useAuthenticatedUser().activeOrganizationId;
  const [view, setView] = useState<View>({ kind: "list" });
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const {
    data: flowsData,
    isLoading,
    isError,
  } = useQuery({
    ...flowsOptions(organizationId, FLOW_PICKER_LIMIT),
    refetchOnWindowFocus: false,
  });

  const flows: FlowListItem[] =
    flowsData && "items" in flowsData ? flowsData.items : [];

  const handleBackToList = () => setView({ kind: "list" });

  const handleToggleEnabled = async (flow: FlowListItem, enabled: boolean) => {
    setTogglingId(flow.id);
    const flowId = toSafeId<"flowDefinition">(flow.id);

    // The update endpoint takes the full definition, so read it back and PUT it
    // with the flipped `enabled` flag. Force a fresh read (`staleTime: 0`): the
    // cached detail can be up to five minutes old, so replaying it would clobber
    // another user's concurrent edits to name/description/steps/trigger. A
    // dedicated enabled-only mutation (see the PR follow-ups) would remove the
    // full-body replay entirely; this closes the stale-cache window.
    const detailResult = await Result.tryPromise(async () =>
      queryClient.query({
        ...flowDetailOptions(organizationId, flow.id),
        staleTime: 0,
      }),
    );
    if (Result.isError(detailResult)) {
      setTogglingId(null);
      getAnalytics().captureError(detailResult.error);
      notifyUserError(detailResult.error, t("flows.saveFailed"));
      return;
    }
    const detail = detailResult.value;

    const response = await api.flows({ flowId }).put({
      name: detail.name,
      description: detail.description,
      steps: detail.steps,
      trigger: toTriggerBody(detail.trigger),
      enabled,
    });
    setTogglingId(null);

    if (response.error) {
      notifyUserError(toAPIError(response.error), t("flows.saveFailed"), {
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.flows.all(organizationId),
      }),
      "knowledge-workflows.invalidate",
    );
  };

  if (view.kind === "editor") {
    return (
      <FlowEditor
        example={view.example}
        flowId={view.flowId}
        onBack={handleBackToList}
        onSaved={handleBackToList}
        organizationId={organizationId}
      />
    );
  }

  if (isLoading) {
    return <WorkflowsPageSkeleton />;
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("flows.loadFailed")}</p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      {...guideAnchor(GUIDE_ANCHORS.workflowsOverview)}
    >
      <FlowList
        flows={flows}
        onNewFlow={() => setView({ kind: "editor", flowId: null })}
        onRefresh={() => {
          detached(
            queryClient.invalidateQueries({
              queryKey: knowledgeKeys.flows.all(organizationId),
            }),
            "knowledge-workflows.invalidate",
          );
        }}
        onSelect={(flow) => setView({ kind: "editor", flowId: flow.id })}
        onStartExample={(example) =>
          setView({ kind: "editor", flowId: null, example })
        }
        onToggleEnabled={(flow, enabled) => {
          detached(
            handleToggleEnabled(flow, enabled),
            "knowledge-workflows.toggle-enabled",
          );
        }}
        togglingId={togglingId}
      />
    </div>
  );
}

function GuardedWorkflowsPage() {
  return (
    <KnowledgeMemberOnly pending={<WorkflowsPageSkeleton />}>
      {(organizationId) => <RouteComponent key={organizationId} />}
    </KnowledgeMemberOnly>
  );
}
