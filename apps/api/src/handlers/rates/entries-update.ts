import { Result } from "better-result";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateEntryBodySchema = t.Object({
  id: tSafeId("rateEntry"),
  hourlyRate: t.Optional(t.Integer({ minimum: 0 })),
  effectiveFrom: t.Optional(t.String({ format: "date" })),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

const updateRateEntry = createSafeHandler(
  {
    permissions: { rate: ["update"] },
    params: rateEntryParamsSchema,
    body: updateRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    const table = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: {
            id: { eq: params.rateTableId },
            workspaceId: { eq: workspaceId },
          },
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
          where: {
            id: { eq: body.id },
            rateTableId: { eq: params.rateTableId },
          },
          columns: {
            id: true,
            userId: true,
            hourlyRate: true,
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

    const updates = {
      ...pickDefined(body, ["effectiveFrom", "effectiveTo"]),
      ...(body.hourlyRate !== undefined
        ? { hourlyRate: cents(body.hourlyRate) }
        : {}),
    };

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
            where: {
              id: { eq: body.id },
              rateTableId: { eq: params.rateTableId },
            },
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

        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of [
          "effectiveFrom",
          "effectiveTo",
          "hourlyRate",
        ] as const) {
          const next = updates[field];
          if (next !== undefined) {
            changes[field] = { old: existing[field] ?? null, new: next };
          }
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_ENTRY,
          resourceId: body.id,
          changes,
        });

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
