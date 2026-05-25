import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteBillingCodeBodySchema = t.Object({
  id: tSafeId("billingCode"),
});

const config = {
  permissions: { billingCode: ["delete"] },
  body: deleteBillingCodeBodySchema,
} satisfies HandlerConfig;

const deleteBillingCode = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.billingCodes.findFirst({
          where: {
            id: { eq: body.id },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            type: true,
            code: true,
            label: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Billing code not found" }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
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
      }),
    );

    return Result.ok({ deleted: true });
  },
);

export default deleteBillingCode;
