import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { tableChartRequestSchema } from "@stll/api-contract/table-chart";

import { planTableChart } from "@/api/handlers/chat/table-chart-plan";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
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

const tableChart = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield -- planning returns one Result with no intermediate operation.
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
      return Result.err(
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
        decide: decideMany,
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

export default tableChart;
