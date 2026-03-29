import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createRateTableBodySchema = t.Object({
  name: tDefaultVarchar,
  currency: t.String({ minLength: 3, maxLength: 3 }),
  isDefault: t.Optional(t.Boolean()),
});

const createRateTable = createHandler(
  {
    permissions: { rate: ["create"] },
    body: createRateTableBodySchema,
  },
  async ({ scopedDb, session, workspaceId, body }) =>
    await scopedDb(async (tx) => {
      // Lock rows then count to serialize concurrent adds.
      // PG rejects FOR UPDATE with aggregate functions.
      const lockedRows = await tx
        .select({ id: rateTables.id })
        .from(rateTables)
        .where(eq(rateTables.workspaceId, workspaceId))
        .for("update");

      if (lockedRows.length >= LIMITS.rateTablesPerWorkspace) {
        return status(400, {
          message: "Rate tables limit reached for this workspace",
        });
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
        return status(500, { message: "Failed to create rate table" });
      }
      return { id: table.id };
    }),
);

export default createRateTable;
