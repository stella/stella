import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { outboundActions } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionScopedCount } from "@/api/lib/db/transitions";

const config = {
  contract: "patch",
  permissions: { integration: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "human_confirmation" },
  params: v.object({ actionId: resourceIdSchema("outboundAction") }),
} satisfies HandlerConfig;

/** Drop a pending action so it can never be confirmed. Idempotent. */
const discardOutboundAction = createSafeRootHandler(
  config,
  async function* ({
    params: { actionId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const discarded = yield* Result.await(
      safeDb(async (tx) => {
        const now = new Date();
        await withAggregateLock({
          aggregate: "outboundAction",
          id: {
            id: actionId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
          },
          mode: "update",
          tx,
        });
        return await transitionScopedCount({
          tx,
          spec: TRANSITIONS.outboundActions,
          where: sql`${and(
            eq(outboundActions.id, actionId),
            eq(outboundActions.organizationId, session.activeOrganizationId),
            eq(outboundActions.userId, user.id),
          )}`,
          options: {
            from: ["pending"],
            to: "discarded",
            set: { completedAt: now, updatedAt: now },
          },
          recordTransitionAuditEvent: async (auditTx) => {
            // The successful update holds this actor-scoped row until commit.
            const row = (
              await auditTx
                .select({ kind: outboundActions.kind })
                .from(outboundActions)
                .where(
                  and(
                    eq(outboundActions.id, actionId),
                    eq(
                      outboundActions.organizationId,
                      session.activeOrganizationId,
                    ),
                    eq(outboundActions.userId, user.id),
                  ),
                )
                .limit(1)
            ).at(0);
            if (!row) {
              panic(
                "A discarded outbound action must exist in its transaction",
              );
            }
            await recordAuditEvent(auditTx, {
              action: AUDIT_ACTION.CANCEL,
              resourceType: AUDIT_RESOURCE_TYPE.OUTBOUND_ACTION,
              resourceId: actionId,
              workspaceId: null,
              metadata: { kind: row.kind, operation: "discard" },
            });
          },
        });
      }),
    );
    return Result.ok({ discarded: discarded > 0 });
  },
);

declareAggregateMutation(discardOutboundAction.handler, {
  type: "aggregate",
  aggregates: ["outboundAction"],
});

export default discardOutboundAction;
