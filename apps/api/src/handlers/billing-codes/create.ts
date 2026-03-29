import { panic } from "better-result";
import { eq } from "drizzle-orm";
import { status, t } from "elysia";

import { billingCodes } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

const createBillingCodeBodySchema = t.Object({
  type: t.UnionEnum(["task", "activity"]),
  code: t.String({ minLength: 1, maxLength: 20 }),
  label: t.String({ minLength: 1, maxLength: 256 }),
  active: t.Optional(t.Boolean()),
  sortOrder: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  permissions: { billingCode: ["create"] },
  body: createBillingCodeBodySchema,
} satisfies HandlerConfig;

const createBillingCode = createHandler(
  config,
  async ({ scopedDb, session, workspaceId, body }) => {
    const totalCodes = await scopedDb((tx) =>
      tx.$count(billingCodes, eq(billingCodes.workspaceId, workspaceId)),
    );

    if (totalCodes >= LIMITS.billingCodesPerWorkspace) {
      return status(400, {
        message: "Billing codes limit reached for this workspace",
      });
    }

    try {
      const [code] = await scopedDb((tx) =>
        tx
          .insert(billingCodes)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            type: body.type,
            code: body.code,
            label: body.label,
            active: body.active ?? true,
            sortOrder: body.sortOrder ?? 0,
          })
          .returning({ id: billingCodes.id }),
      );

      if (!code) {
        panic("Failed to create billing code");
      }
      return { id: code.id };
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        return status(409, {
          message: "A billing code with this code already exists",
        });
      }
      throw error;
    }
  },
);

export default createBillingCode;
