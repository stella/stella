import { and, eq, gte, isNull, lte, ne, or } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";

export const updateRateEntryBodySchema = t.Object({
  id: tNanoid,
  hourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  effectiveFrom: t.Optional(t.String({ format: "date" })),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

type UpdateRateEntryBodySchema = Static<typeof updateRateEntryBodySchema>;

type UpdateRateEntryHandlerProps = {
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  body: UpdateRateEntryBodySchema;
};

export const updateRateEntryHandler = async ({
  workspaceId,
  rateTableId,
  body,
}: UpdateRateEntryHandlerProps) => {
  const table = await db.query.rateTables.findFirst({
    where: { id: rateTableId, workspaceId: { eq: workspaceId } },
    columns: { id: true },
  });

  if (!table) {
    return status(404, { message: "Rate table not found" });
  }

  const existing = await db.query.rateEntries.findFirst({
    where: { id: body.id, rateTableId },
    columns: {
      id: true,
      userId: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
  });

  if (!existing) {
    return status(404, { message: "Rate entry not found" });
  }

  const resolvedFrom = body.effectiveFrom ?? existing.effectiveFrom;
  const resolvedTo =
    body.effectiveTo !== undefined ? body.effectiveTo : existing.effectiveTo;

  if (resolvedTo && resolvedTo < resolvedFrom) {
    return status(400, {
      message: "effectiveTo must be >= effectiveFrom",
    });
  }

  // Check for overlapping date ranges if dates changed
  if (body.effectiveFrom !== undefined || body.effectiveTo !== undefined) {
    const userCondition = existing.userId
      ? eq(rateEntries.userId, existing.userId)
      : isNull(rateEntries.userId);

    const overlapFromCondition = resolvedTo
      ? lte(rateEntries.effectiveFrom, resolvedTo)
      : undefined;

    const overlapToCondition = or(
      isNull(rateEntries.effectiveTo),
      gte(rateEntries.effectiveTo, resolvedFrom),
    );

    const overlapConditions = [
      eq(rateEntries.rateTableId, rateTableId),
      userCondition,
      ne(rateEntries.id, body.id),
      overlapToCondition,
    ];
    if (overlapFromCondition) {
      overlapConditions.push(overlapFromCondition);
    }

    const [overlap] = await db
      .select({ id: rateEntries.id })
      .from(rateEntries)
      .where(and(...overlapConditions))
      .limit(1);

    if (overlap) {
      return status(400, {
        message: "Date range overlaps with an existing entry for this user",
      });
    }
  }

  const updates: Record<string, unknown> = {};

  if (body.hourlyRate !== undefined) {
    updates.hourlyRate = body.hourlyRate;
  }
  if (body.effectiveFrom !== undefined) {
    updates.effectiveFrom = body.effectiveFrom;
  }
  if (body.effectiveTo !== undefined) {
    updates.effectiveTo = body.effectiveTo;
  }

  if (Object.keys(updates).length === 0) {
    return { id: body.id };
  }

  await db
    .update(rateEntries)
    .set(updates)
    .where(
      and(
        eq(rateEntries.id, body.id),
        eq(rateEntries.rateTableId, rateTableId),
      ),
    );

  return { id: body.id };
};
