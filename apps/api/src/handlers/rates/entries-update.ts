import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { status, t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateEntryBodySchema = t.Object({
  id: tNanoid,
  hourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  effectiveFrom: t.Optional(t.String({ format: "date" })),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

const rateEntryParamsSchema = t.Object({
  rateTableId: tNanoid,
});

const updateRateEntry = createHandler(
  {
    permissions: { rate: ["update"] },
    params: rateEntryParamsSchema,
    body: updateRateEntryBodySchema,
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

    const existing = await scopedDb((tx) =>
      tx.query.rateEntries.findFirst({
        where: { id: body.id, rateTableId: params.rateTableId },
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

    return scopedDb(async (tx) => {
      if (datesChanged) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${params.rateTableId}))`,
        );

        const locked = await tx.query.rateEntries.findFirst({
          where: { id: body.id, rateTableId: params.rateTableId },
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
          body.effectiveTo !== undefined
            ? body.effectiveTo
            : locked.effectiveTo;

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
          eq(rateEntries.rateTableId, params.rateTableId),
          userCondition,
          ne(rateEntries.id, body.id),
          overlapToCondition,
        ];
        if (overlapFromCondition) {
          overlapConditions.push(overlapFromCondition);
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
      }

      await tx
        .update(rateEntries)
        .set(updates)
        .where(
          and(
            eq(rateEntries.id, body.id),
            eq(rateEntries.rateTableId, params.rateTableId),
          ),
        );

      return { id: body.id };
    });
  },
);

export default updateRateEntry;
