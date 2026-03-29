import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createRateEntryBodySchema = t.Object({
  userId: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  hourlyRate: t.Integer({ minimum: 0 }),
  effectiveFrom: t.String({ format: "date" }),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

const rateEntryParamsSchema = t.Object({
  rateTableId: tNanoid,
});

const createRateEntry = createHandler(
  {
    permissions: { rate: ["create"] },
    params: rateEntryParamsSchema,
    body: createRateEntryBodySchema,
  },
  async ({ scopedDb, workspaceId, params, body }) => {
    const table = await scopedDb((tx) =>
      tx.query.rateTables.findFirst({
        where: { id: params.rateTableId, workspaceId: { eq: workspaceId } },
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
      eq(rateEntries.rateTableId, params.rateTableId),
      userCondition,
      overlapToCondition,
    ];
    if (overlapFromCondition) {
      overlapConditions.push(overlapFromCondition);
    }

    return scopedDb(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${params.rateTableId}))`,
      );

      const totalEntries = await tx.$count(
        rateEntries,
        eq(rateEntries.rateTableId, params.rateTableId),
      );

      if (totalEntries >= LIMITS.rateEntriesPerTable) {
        return status(400, {
          message: "Rate entries limit reached for this table",
        });
      }

      const overlapRows = await tx
        .select({ id: rateEntries.id })
        .from(rateEntries)
        .where(and(...overlapConditions))
        .limit(1);
      const overlap = overlapRows.at(0);

      if (overlap) {
        return status(400, {
          message: "Date range overlaps with an existing entry for this user",
        });
      }

      const [entry] = await tx
        .insert(rateEntries)
        .values({
          workspaceId,
          rateTableId: params.rateTableId,
          userId: body.userId ?? null,
          hourlyRate: body.hourlyRate,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
        })
        .returning({ id: rateEntries.id });

      if (!entry) {
        return status(500, { message: "Failed to create rate entry" });
      }
      return { id: entry.id };
    });
  },
);

export default createRateEntry;
