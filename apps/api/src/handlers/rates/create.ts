import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateTables } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createRateTableBodySchema = t.Object({
  name: tDefaultVarchar,
  currency: t.String({ minLength: 3, maxLength: 3 }),
  isDefault: t.Optional(t.Boolean()),
});

type CreateRateTableBodySchema = Static<typeof createRateTableBodySchema>;

type CreateRateTableHandlerProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateRateTableBodySchema;
};

export const createRateTableHandler = async ({
  organizationId,
  workspaceId,
  body,
}: CreateRateTableHandlerProps) => {
  const totalTables = await db.$count(
    rateTables,
    eq(rateTables.workspaceId, workspaceId),
  );

  if (totalTables >= LIMITS.rateTablesPerWorkspace) {
    return status(400, {
      message: "Rate tables limit reached for this workspace",
    });
  }

  const [table] = await db.transaction(async (tx) => {
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

    return tx
      .insert(rateTables)
      .values({
        organizationId,
        workspaceId,
        name: body.name,
        currency: body.currency,
        isDefault: body.isDefault ?? false,
      })
      .returning({ id: rateTables.id });
  });

  return { id: table.id };
};
