import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
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
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  body: CreateRateEntryBodySchema;
};

export const createRateEntryHandler = async ({
  scopedDb,
  workspaceId,
  rateTableId,
  body,
}: CreateRateEntryHandlerProps) => {
  const table = await scopedDb((tx) =>
    tx.query.rateTables.findFirst({
      where: { id: rateTableId, workspaceId: { eq: workspaceId } },
      columns: { id: true },
    }),
  );

  if (!table) {
    return status(404, { message: "Rate table not found" });
  }

  if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) {
    return status(400, {
      message: "effectiveTo must be >= effectiveFrom",
    });
  }

  // Build overlap conditions outside the transaction
  // (pure computation, no DB access).
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

  // Advisory lock + count + overlap check + insert in one
  // transaction to prevent TOCTOU on the limit and overlap.
  return scopedDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${rateTableId}))`,
    );

    const totalEntries = await tx.$count(
      rateEntries,
      eq(rateEntries.rateTableId, rateTableId),
    );

    if (totalEntries >= LIMITS.rateEntriesPerTable) {
      return status(400, {
        message: "Rate entries limit reached for this table",
      });
    }

    const [overlap] = await tx
      .select({ id: rateEntries.id })
      .from(rateEntries)
      .where(and(...overlapConditions))
      .limit(1);

    if (overlap) {
      return status(400, {
        message: "Date range overlaps with an existing entry for this user",
      });
    }

    const [entry] = await tx
      .insert(rateEntries)
      .values({
        workspaceId,
        rateTableId,
        userId: body.userId ?? null,
        hourlyRate: body.hourlyRate,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo ?? null,
      })
      .returning({ id: rateEntries.id });

    return { id: entry.id };
  });
};
