import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { FlowEditor } from "@/routes/_protected.knowledge/-components/flow-editor";
import { FlowList } from "@/routes/_protected.knowledge/-components/flow-list";
import type {
  FlowDefinitionBody,
  FlowDefinitionDetail,
  FlowListItem,
} from "@/routes/_protected.knowledge/-components/flow-types";
import {
  FLOW_PICKER_LIMIT,
  flowDetailOptions,
  flowsOptions,
  knowledgeKeys,
} from "@/routes/_protected.knowledge/-queries";

type View = { kind: "list" } | { kind: "editor"; flowId: string | null };

export const Route = createFileRoute("/_protected/knowledge/workflows")({
  component: RouteComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

const FLOW_ROW_KEYS = ["a", "b", "c", "d", "e"];

// The GET response carries workspace ids as plain strings; the PUT body
// expects branded SafeIds, so rebrand before sending a fetched trigger back.
const toTriggerBody = (
  trigger: FlowDefinitionDetail["trigger"],
): FlowDefinitionBody["trigger"] => {
  if (trigger.type === "schedule") {
    return {
      ...trigger,
      workspaceId: toSafeId<"workspace">(trigger.workspaceId),
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
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
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

    // The update endpoint takes the full definition; fetch (cached) detail,
    // then PUT it back with the flipped `enabled` flag.
    const detail = await queryClient
      .fetchQuery(flowDetailOptions(organizationId, flow.id))
      .catch(() => null);

    if (!detail || !("steps" in detail)) {
      setTogglingId(null);
      stellaToast.add({ type: "error", title: t("flows.saveFailed") });
      return;
    }

    const response = await api.flows({ flowId }).put({
      name: detail.name,
      description: detail.description,
      steps: detail.steps,
      trigger: toTriggerBody(detail.trigger),
      enabled,
    });
    setTogglingId(null);

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("flows.saveFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.flows.all(organizationId),
    });
  };

  if (view.kind === "editor") {
    return (
      <FlowEditor
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
    <FlowList
      flows={flows}
      onNewFlow={() => setView({ kind: "editor", flowId: null })}
      onRefresh={() => {
        void queryClient.invalidateQueries({
          queryKey: knowledgeKeys.flows.all(organizationId),
        });
      }}
      onSelect={(flow) => setView({ kind: "editor", flowId: flow.id })}
      onToggleEnabled={(flow, enabled) => {
        void handleToggleEnabled(flow, enabled);
      }}
      togglingId={togglingId}
    />
  );
}
