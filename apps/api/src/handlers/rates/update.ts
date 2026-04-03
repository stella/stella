import { and, eq, ne } from "drizzle-orm";
import { status, t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateTableBodySchema = t.Object({
  id: tNanoid,
  name: t.Optional(tDefaultVarchar),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  isDefault: t.Optional(t.Boolean()),
});

const updateRateTable = createHandler(
  {
    permissions: { rate: ["update"] },
    body: updateRateTableBodySchema,
  },
  async ({ scopedDb, workspaceId, body }) => {
    const existing = await scopedDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { id: body.id, workspaceId: { eq: workspaceId } },
        columns: { id: true },
      }),
    );

    if (!existing) {
      return status(404, { message: "Rate table not found" });
    }

    const updates = {
      ...pickDefined(body, ["name", "currency", "isDefault"]),
      updatedAt: new Date(),
    };

    // Prevent unsetting isDefault if no other default exists
    if (body.isDefault === false) {
      const otherDefaultRows = await scopedDb((tx) =>
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
      );
      const otherDefault = otherDefaultRows.at(0);

      if (!otherDefault) {
        return status(400, {
          message: "Cannot unset default: no other default rate table exists",
        });
      }
    }

    await scopedDb(async (tx) => {
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

      await tx
        .update(rateTables)
        .set(updates)
        .where(
          and(
            eq(rateTables.id, body.id),
            eq(rateTables.workspaceId, workspaceId),
          ),
        );
    });

    return { id: body.id };
  },
);

export default updateRateTable;
