import { and, eq, ne } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateTables } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tNanoid } from "@/api/lib/custom-schema";

export const updateRateTableBodySchema = t.Object({
  id: tNanoid,
  name: t.Optional(tDefaultVarchar),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  isDefault: t.Optional(t.Boolean()),
});

type UpdateRateTableBodySchema = Static<typeof updateRateTableBodySchema>;

type UpdateRateTableHandlerProps = {
  workspaceId: SafeId<"workspace">;
  body: UpdateRateTableBodySchema;
};

export const updateRateTableHandler = async ({
  workspaceId,
  body,
}: UpdateRateTableHandlerProps) => {
  const existing = await db.query.rateTables.findFirst({
    where: { id: body.id, workspaceId: { eq: workspaceId } },
    columns: { id: true },
  });

  if (!existing) {
    return status(404, { message: "Rate table not found" });
  }

  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.name !== undefined) {
    updates.name = body.name;
  }
  if (body.currency !== undefined) {
    updates.currency = body.currency;
  }
  if (body.isDefault !== undefined) {
    updates.isDefault = body.isDefault;
  }

  // Prevent unsetting isDefault if no other default exists
  if (body.isDefault === false) {
    const [otherDefault] = await db
      .select({ id: rateTables.id })
      .from(rateTables)
      .where(
        and(
          eq(rateTables.workspaceId, workspaceId),
          eq(rateTables.isDefault, true),
          ne(rateTables.id, body.id),
        ),
      )
      .limit(1);

    if (!otherDefault) {
      return status(400, {
        message: "Cannot unset default: no other default rate table exists",
      });
    }
  }

  await db.transaction(async (tx) => {
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
};
