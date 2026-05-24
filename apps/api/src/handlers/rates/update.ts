import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateTableBodySchema = t.Object({
  id: tSafeId("rateTable"),
  name: t.Optional(tDefaultVarchar),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  isDefault: t.Optional(t.Boolean()),
});

const updateRateTable = createSafeHandler(
  {
    permissions: { rate: ["update"] },
    body: updateRateTableBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: { eq: body.id }, workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            currency: true,
            isDefault: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const changedFields = pickDefined(body, ["name", "currency", "isDefault"]);
    const updates = {
      ...changedFields,
      updatedAt: new Date(),
    };

    // Prevent unsetting isDefault if no other default exists
    if (body.isDefault === false) {
      const otherDefaultRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
                ne(rateTables.id, body.id),
              ),
            )
            .limit(1),
        ),
      );
      const otherDefault = otherDefaultRows.at(0);

      if (!otherDefault) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Cannot unset default: no other default rate table exists",
          }),
        );
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
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

        await tx
          .update(rateTables)
          .set(updates)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );

        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of ["name", "currency", "isDefault"] as const) {
          const next = changedFields[field];
          if (next !== undefined) {
            changes[field] = { old: existing[field], new: next };
          }
        }

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
            resourceId: body.id,
            changes,
          },
          ...previousDefaults
            .filter((row) => row.id !== body.id)
            .map((row) => ({
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
              resourceId: row.id,
              changes: {
                isDefault: { old: true, new: false },
              },
            })),
        ]);
      }),
    );

    return Result.ok({ id: body.id });
  },
);

export default updateRateTable;
