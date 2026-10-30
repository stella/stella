import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { billingCodes, rateEntries } from "@/api/db/schema";
import { billingCodeRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { lockBillingCode } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteBillingCodeBodySchema = v.object({
  id: resourceIdSchema("billingCode"),
});

const config = {
  contract: "patch",
  description:
    "Permanently delete one billing code (a task or activity code) from a " +
    "matter's code list. Time entries already recorded under it keep their " +
    "stored code string, so past entries are not rewritten; the code just " +
    "stops being offered. Remove activity rates referencing the code before deleting it.",
  permissions: { billingCode: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  realtime: billingCodeRealtimeUpdates,
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  body: deleteBillingCodeBodySchema,
} satisfies WorkspaceHandlerConfig;

const deleteBillingCode = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await lockBillingCode(tx, {
          id: body.id,
          workspaceId,
        });
        if (!existing) {
          return { type: "not_found" as const };
        }
        const references = await tx
          .select({ id: rateEntries.id })
          .from(rateEntries)
          .where(
            and(
              eq(rateEntries.workspaceId, workspaceId),
              eq(rateEntries.activityCodeId, body.id),
            ),
          )
          .limit(1);
        if (references.length > 0) {
          return { type: "referenced" as const };
        }
        await tx
          .delete(billingCodes)
          .where(
            and(
              eq(billingCodes.id, body.id),
              eq(billingCodes.workspaceId, workspaceId),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.BILLING_CODE,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                type: existing.type,
                code: existing.code,
                label: existing.label,
              },
              new: null,
            },
          },
        });
        return { type: "deleted" as const };
      }),
    );
    switch (outcome.type) {
      case "not_found":
        return Result.err(
          new HandlerError({ status: 404, message: "Billing code not found" }),
        );
      case "referenced":
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "Remove the activity rates using this code before deleting it",
          }),
        );
      case "deleted":
        break;
      default: {
        outcome satisfies never;
        return panic("Unknown billing code deletion outcome");
      }
    }

    return Result.ok({ deleted: true });
  },
);

export default deleteBillingCode;
