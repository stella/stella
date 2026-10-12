import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { tableChartRequestSchema } from "@stll/api-contract/table-chart";

import type { TableChartDecisionCaller } from "@/api/handlers/chat/table-chart-plan";
import { planTableChart } from "@/api/handlers/chat/table-chart-plan";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decideMany } from "@/api/lib/workflow/decisions/decide";

const config = {
  contract: "patch",
  actionAdmission: { type: "handler", actionKind: "chat.table-chart" },
  requiresUsage: { actionType: "chat", modelRole: "fast" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "assistant_chat" },
  // Validate privately: framework errors must not echo table contents.
  body: t.Unknown(),
} satisfies HandlerConfig;

type CreateTableChartOptions = { decide: TableChartDecisionCaller };

export const createTableChart = ({ decide }: CreateTableChartOptions) =>
  createSafeRootHandler(
    config,
    async function* ({
      actionSignal,
      body,
      orgAIConfig,
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
      return Result.ok(
        await planTableChart({
          table: table.output,
          decide,
          decisionOptions: {
            orgAIConfig,
            abortSignal: actionSignal ?? request.signal,
            usageMetering: {
              actionType: "chat",
              organizationId: session.activeOrganizationId,
              safeDb,
              userId: user.id,
              workspaceId: null,
              serviceTier: "standard",
              callId: Bun.randomUUIDv7(),
            },
          },
        }),
      );
    },
  );

const tableChart = createTableChart({ decide: decideMany });
declareAggregateMutation(tableChart.handler, {
  type: "independent",
  reason:
    "Plans a client-supplied table; decision logging and usage metering are owned by their append-only services, with no chat aggregate mutation.",
});

export default tableChart;
