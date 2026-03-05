import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export const createRateEntryBodySchema = t.Object({
  userId: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  hourlyRate: t.Integer({ minimum: 0 }),
  effectiveFrom: t.String({ format: "date" }),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

type CreateRateEntryBodySchema = Static<typeof createRateEntryBodySchema>;

type CreateRateEntryHandlerProps = {
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  body: CreateRateEntryBodySchema;
};

export const createRateEntryHandler = async ({
  workspaceId,
  rateTableId,
  body,
}: CreateRateEntryHandlerProps) => {
  const table = await db.query.rateTables.findFirst({
    where: { id: rateTableId, workspaceId: { eq: workspaceId } },
    columns: { id: true },
  });

  if (!table) {
    return status(404, { message: "Rate table not found" });
  }

  const totalEntries = await db.$count(
    rateEntries,
    eq(rateEntries.rateTableId, rateTableId),
  );

  if (totalEntries >= LIMITS.rateEntriesPerTable) {
    return status(400, {
      message: "Rate entries limit reached for this table",
    });
  }

  if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) {
    return status(400, {
      message: "effectiveTo must be >= effectiveFrom",
    });
  }

  // Check for overlapping date ranges with the same userId
  const userCondition = body.userId
    ? eq(rateEntries.userId, body.userId)
    : isNull(rateEntries.userId);

  const overlapFromCondition = body.effectiveTo
    ? lte(rateEntries.effectiveFrom, body.effectiveTo)
    : undefined;

  const overlapToCondition = or(
    isNull(rateEntries.effectiveTo),
    gte(rateEntries.effectiveTo, body.effectiveFrom),
  );

  const overlapConditions = [
    eq(rateEntries.rateTableId, rateTableId),
    userCondition,
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

  const [entry] = await db
    .insert(rateEntries)
    .values({
      rateTableId,
      userId: body.userId ?? null,
      hourlyRate: body.hourlyRate,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
    })
    .returning({ id: rateEntries.id });

  return { id: entry.id };
};
