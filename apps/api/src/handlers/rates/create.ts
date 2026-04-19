import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
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
  async function* ({ safeDb, session, workspaceId, body }) {
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

        if (body.isDefault) {
          await tx
            .update(rateTables)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
              ),
            );
        }

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
