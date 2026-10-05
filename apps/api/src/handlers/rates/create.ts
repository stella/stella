import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { rateTables } from "@/api/db/schema";
import { rateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tCurrencyCode, tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createRateTableBodySchema = t.Object({
  name: tDefaultVarchar,
  currency: tCurrencyCode,
  isDefault: t.Optional(t.Boolean()),
});

const createRateTable = createSafeHandler(
  {
    description:
      "Create a rate table, a named set of hourly rates in a single " +
      "currency, in a matter. Pass isDefault to make it the matter's " +
      "default, which clears the flag on the previous default; matters have " +
      "a fixed cap on how many rate tables they may hold. Add the rates " +
      "themselves with rates.entries.create.",
    permissions: { rate: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: rateRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: createRateTableBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    const txResult = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        // Row locks cannot serialize the first table in an empty matter.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`,
        );
        // Lock rows then count to serialize concurrent adds.
        // PG rejects FOR UPDATE with aggregate functions.
        const lockedRows = await tx
          .select({ id: rateTables.id })
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId))
          .for("update");

        if (lockedRows.length >= LIMITS.rateTablesPerWorkspace) {
          throw new HandlerError({
            status: 400,
            message: "Rate tables limit reached for this workspace",
          });
        }

        const previousDefaults = body.isDefault
          ? await tx
              .update(rateTables)
              .set({ isDefault: false, updatedAt: new Date() })
              .where(
                and(
                  eq(rateTables.workspaceId, workspaceId),
                  eq(rateTables.isDefault, true),
                ),
              )
              .returning({ id: rateTables.id })
          : [];

        const [table] = await tx
          .insert(rateTables)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId,
            name: body.name,
            currency: body.currency,
            isDefault: body.isDefault ?? false,
          })
          .returning({ id: rateTables.id });

        if (!table) {
          // The insert cleared the workspace's previous default table above, so
          // returning here would commit a workspace with no default at all.
          throw new HandlerError({
            status: 500,
            message: "Failed to create rate table",
          });
        }

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
            resourceId: table.id,
            changes: {
              created: {
                old: null,
                new: {
                  name: body.name,
                  currency: body.currency,
                  isDefault: body.isDefault ?? false,
                },
              },
            },
          },
          ...previousDefaults.map((row) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
            resourceId: row.id,
            changes: {
              isDefault: { old: true, new: false },
            },
          })),
        ]);

        return { id: table.id };
      }),
    );

    return Result.ok({ id: txResult.id });
  },
);

export default createRateTable;
