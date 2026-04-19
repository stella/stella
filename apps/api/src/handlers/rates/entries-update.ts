import { Result } from "better-result";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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

const updateRateEntry = createSafeHandler(
  {
    permissions: { rate: ["update"] },
    params: rateEntryParamsSchema,
    body: updateRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body }) {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: params.rateTableId, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      ),
    );

    if (!table) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateEntries.findFirst({
          where: { id: body.id, rateTableId: params.rateTableId },
          columns: {
            id: true,
            userId: true,
            effectiveFrom: true,
            effectiveTo: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate entry not found" }),
      );
    }

    const updates = pickDefined(body, [
      "hourlyRate",
      "effectiveFrom",
      "effectiveTo",
    ]);

    if (Object.keys(updates).length === 0) {
      return Result.ok({ id: body.id });
    }

    const datesChanged =
      body.effectiveFrom !== undefined || body.effectiveTo !== undefined;

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
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
            return {
              ok: false as const,
              status: 404 as const,
              message: "Rate entry not found",
            };
          }

          const resolvedFrom = body.effectiveFrom ?? locked.effectiveFrom;
          const resolvedTo =
            body.effectiveTo !== undefined
              ? body.effectiveTo
              : locked.effectiveTo;

          if (resolvedTo && resolvedTo < resolvedFrom) {
            return {
              ok: false as const,
              status: 400 as const,
              message: "effectiveTo must be >= effectiveFrom",
            };
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
            return {
              ok: false as const,
              status: 400 as const,
              message:
                "Date range overlaps with an existing entry for this user",
            };
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

        return { ok: true as const };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    return Result.ok({ id: body.id });
  },
);

export default updateRateEntry;
