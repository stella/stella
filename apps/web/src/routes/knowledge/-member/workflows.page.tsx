import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { useMountEffect } from "@stll/ui/effects";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  captureSessionQueryOwner,
  isCurrentSessionQueryOwner,
  isObservedSessionQueryOwner,
} from "@/lib/account/auth-query-owner";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  useAuthenticatedUser,
  useMaybeAuthenticatedUser,
} from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  FLOW_PICKER_LIMIT,
  flowsOptions,
  knowledgeKeys,
} from "@/lib/knowledge/queries";
import { toSafeId } from "@/lib/safe-id";
import { FlowEditor } from "@/routes/knowledge/-components/flow-editor";
import type { FlowExampleKey } from "@/routes/knowledge/-components/flow-examples";
import { FlowList } from "@/routes/knowledge/-components/flow-list";
import type {
  FlowDefinitionBody,
  FlowDefinitionDetail,
  FlowDefinitionUpdateBody,
  FlowListItem,
} from "@/routes/knowledge/-components/flow-types";
import { KnowledgeMemberOnly } from "@/routes/knowledge/-knowledge-member-only";
import { WorkflowsPending } from "@/routes/knowledge/-member/workflows.pending";

type View =
  | { kind: "list" }
  | { kind: "editor"; flowId: string | null; example?: FlowExampleKey };

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

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { id: userId, activeOrganizationId: organizationId } =
    useAuthenticatedUser();
  const lifetime = useRef<AbortController | null>(null);
  useMountEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (lifetime.current === controller) {
        lifetime.current = null;
      }
    };
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
    const request = lifetime.current;
    const owner = captureSessionQueryOwner(queryClient);
    if (
      !owner ||
      owner.userId !== userId ||
      owner.organizationId !== organizationId ||
      !request
    ) {
      return;
    }
    setTogglingId(flow.id);
    const flowId = toSafeId<"flowDefinition">(flow.id);

    // Read outside the query cache: joining an older in-flight GET would not
    // establish the version paired with this toggle's replacement fields.
    const detailResult = await Result.tryPromise(async () =>
      unwrapApiResponse(
        await api
          .flows({ flowId })
          .get({ fetch: { signal: request.signal, cache: "no-store" } }),
      ),
    );
    if (
      lifetime.current !== request ||
      !isObservedSessionQueryOwner(queryClient, owner)
    ) {
      return;
    }
    if (!isCurrentSessionQueryOwner(queryClient, owner)) {
      setTogglingId(null);
      return;
    }
    if (Result.isError(detailResult)) {
      setTogglingId(null);
      getAnalytics().captureError(detailResult.error, {
        fingerprintKey: "RouteComponent.handleToggleEnabled:failure",
        scope: {
          type: "handler",
          handlerId: "RouteComponent.handleToggleEnabled:failure",
        },
      });
      notifyUserError(detailResult.error, t("flows.saveFailed"));
      return;
    }
    const detail = detailResult.value;

    const outcome = await Result.tryPromise(async () =>
      invokeCapability("flows.update", async (capability) =>
        unwrapApiResponse(
          await api.flows({ flowId }).put(
            {
              name: detail.name,
              description: detail.description,
              steps: detail.steps,
              trigger: toTriggerBody(detail.trigger),
              enabled,
              expectedUpdatedAt: detail.updatedAt,
            } satisfies FlowDefinitionUpdateBody,
            capability,
          ),
        ),
      ),
    );
    if (outcome.isOk()) {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.flows.all(organizationId),
        }),
        "knowledge-workflows.invalidate",
      );
    }
    if (
      lifetime.current !== request ||
      !isObservedSessionQueryOwner(queryClient, owner)
    ) {
      return;
    }
    setTogglingId(null);
    if (!isCurrentSessionQueryOwner(queryClient, owner)) {
      return;
    }
    if (outcome.isErr()) {
      notifyUserError(outcome.error.cause, t("flows.saveFailed"), {
        description: userErrorFromThrown(
          outcome.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }
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
    return <WorkflowsPending />;
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

/** The organization's workflows: the list, or one open in the editor. */
export function WorkflowsPage() {
  const user = useMaybeAuthenticatedUser();
  return (
    <KnowledgeMemberOnly pending={<WorkflowsPending />}>
      {(organizationId) => (
        <RouteComponent key={JSON.stringify([organizationId, user?.id])} />
      )}
    </KnowledgeMemberOnly>
  );
}
