import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { rateEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateRateEntryBodySchema = t.Object({
  id: tNanoid,
  hourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  effectiveFrom: t.Optional(t.String({ format: "date" })),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

type UpdateRateEntryBodySchema = Static<typeof updateRateEntryBodySchema>;

type UpdateRateEntryHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  rateTableId: string;
  body: UpdateRateEntryBodySchema;
};

export const updateRateEntryHandler = async ({
  scopedDb,
  workspaceId,
  rateTableId,
  body,
}: UpdateRateEntryHandlerProps) => {
  const table = await scopedDb((tx) =>
    tx.query.rateTables.findFirst({
      where: { id: rateTableId, workspaceId: { eq: workspaceId } },
      columns: { id: true },
    }),
  );

  if (!table) {
    return status(404, { message: "Rate table not found" });
  }

  const existing = await scopedDb((tx) =>
    tx.query.rateEntries.findFirst({
      where: { id: body.id, rateTableId },
      columns: {
        id: true,
        userId: true,
        effectiveFrom: true,
        effectiveTo: true,
      },
    }),
  );

  if (!existing) {
    return status(404, { message: "Rate entry not found" });
  }

  const updates = pickDefined(body, [
    "hourlyRate",
    "effectiveFrom",
    "effectiveTo",
  ]);

  if (Object.keys(updates).length === 0) {
    return { id: body.id };
  }

  const datesChanged =
    body.effectiveFrom !== undefined || body.effectiveTo !== undefined;

  // Advisory lock + overlap check + update in one transaction
  // to prevent TOCTOU on overlapping date ranges. Re-read
  // existing dates inside the lock to avoid stale boundaries.
  return scopedDb(async (tx) => {
    if (datesChanged) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${rateTableId}))`,
      );

      // Re-read inside the lock so resolved dates are fresh.
      const locked = await tx.query.rateEntries.findFirst({
        where: { id: body.id, rateTableId },
        columns: {
          userId: true,
          effectiveFrom: true,
          effectiveTo: true,
        },
      });

      if (!locked) {
        return status(404, {
          message: "Rate entry not found",
        });
      }

      const resolvedFrom = body.effectiveFrom ?? locked.effectiveFrom;
      const resolvedTo =
        body.effectiveTo !== undefined ? body.effectiveTo : locked.effectiveTo;

      if (resolvedTo && resolvedTo < resolvedFrom) {
        return status(400, {
          message: "effectiveTo must be >= effectiveFrom",
        });
      }

      const userCondition = locked.userId
        ? eq(rateEntries.userId, locked.userId)
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
    }

    await tx
      .update(rateEntries)
      .set(updates)
      .where(
        and(
          eq(rateEntries.id, body.id),
          eq(rateEntries.rateTableId, rateTableId),
        ),
      );

    return { id: body.id };
  });
};
