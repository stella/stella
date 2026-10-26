import { Result } from "better-result";
import * as v from "valibot";

import { tableChartRequestSchema } from "@stll/api-contract/table-chart";

import type { TableChartDecisionCaller } from "@/api/handlers/chat/table-chart-plan";
import { planTableChart } from "@/api/handlers/chat/table-chart-plan";
import { resolveCaching } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  ACCOUNT_ACCESS,
  configuredModelAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decideMany } from "@/api/lib/workflow/decisions/decide";

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "chat.table-chart" },
  requiresUsage: { actionType: "chat", modelTask: "short-text" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  // Validate privately: framework errors must not echo table contents.
  body: v.unknown(),
} satisfies HandlerConfig;

type CreateTableChartOptions = { decide: TableChartDecisionCaller };

export const createTableChart = ({ decide }: CreateTableChartOptions) =>
  createSafeRootHandler(
    config,
    async function* ({
      actionSignal,
      body,
      orgAIConfig,
      managedAIResidency,
      modelAdmission,
      promptCachingEnabled,
      request,
      safeDb,
      session,
      user,
    }) {
      const table = v.safeParse(tableChartRequestSchema, body);
      if (!table.success) {
        return yield* Result.err(
          new HandlerError({
            status: 400,
            message:
              "Table cannot be charted: provide a bounded rectangular table",
          }),
        );
      }
      const admission = configuredModelAdmission({ modelAdmission });
      const abortSignal = actionSignal ?? request.signal;
      const usageMetering = {
        actionType: "chat",
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
        workspaceId: null,
        serviceTier: "standard",
      } as const;
      return Result.ok(
        await planTableChart({
          table: table.output,
          decide,
          decisionOptions: {
            orgAIConfig,
            abortSignal,
            usageMetering: { ...usageMetering, callId: Bun.randomUUIDv7() },
            generation: {
              dataClass: "customer",
              userId: user.id,
              orgAIConfig,
              managedAIResidency,
              organizationId: session.activeOrganizationId,
              admission,
              tenantWorkspaceIds: [],
              task: "short-text",
              serviceTier: "standard",
              caching: resolveCaching({
                promptCachingEnabled,
                task: "short-text",
                scopeKey: null,
              }),
              prompt: "Decide the chart of the supplied table.",
              analytics: createTanStackAIAnalyticsCallbacks({
                dataClass: "customer",
                feature: "chat.table-chart",
                modelTask: "short-text",
                orgAIConfig,
                modelTier: admission.modelTier,
                organizationId: session.activeOrganizationId,
                traceId: Bun.randomUUIDv7(),
                usageMetering,
              }),
            },
          },
        }),
      );
    },
  );

const tableChart = createTableChart({ decide: decideMany });
declareAggregateMutation(tableChart, {
  type: "independent",
  reason:
    "Plans a client-supplied table; decision logging and usage metering are owned by their append-only services, with no chat aggregate mutation.",
});

export default tableChart;
