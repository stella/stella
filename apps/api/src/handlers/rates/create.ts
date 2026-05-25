import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createRateTableBodySchema = t.Object({
  name: tDefaultVarchar,
  currency: t.String({ minLength: 3, maxLength: 3 }),
  isDefault: t.Optional(t.Boolean()),
});

const createRateTable = createSafeHandler(
  {
    permissions: { rate: ["create"] },
    body: createRateTableBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        // Lock rows then count to serialize concurrent adds.
        // PG rejects FOR UPDATE with aggregate functions.
        const lockedRows = await tx
          .select({ id: rateTables.id })
          .from(rateTables)
          .where(eq(rateTables.workspaceId, workspaceId))
          .for("update");

        if (lockedRows.length >= LIMITS.rateTablesPerWorkspace) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Rate tables limit reached for this workspace",
          };
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
          return {
            ok: false as const,
            status: 500 as const,
            message: "Failed to create rate table",
          };
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

        return { ok: true as const, id: table.id };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok({ id: txResult.id });
  },
);

export default createRateTable;
