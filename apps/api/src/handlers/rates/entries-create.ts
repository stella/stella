import { Result } from "better-result";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { validateOrgUserId } from "@/api/lib/branded-types";
import { tUuid, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createRateEntryBodySchema = t.Object({
  userId: t.Optional(t.Nullable(t.String({ minLength: 1 }))),
  hourlyRate: t.Integer({ minimum: 0 }),
  effectiveFrom: t.String({ format: "date" }),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

const rateEntryParamsSchema = workspaceParams({ rateTableId: tUuid });

const createRateEntry = createSafeHandler(
  {
    permissions: { rate: ["create"] },
    params: rateEntryParamsSchema,
    body: createRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, session, params, body }) {
    if (body.userId) {
      const userId = body.userId;
      const validatedUserId = yield* Result.await(
        safeDb(
          async (tx) =>
            await validateOrgUserId(tx, userId, session.activeOrganizationId),
        ),
      );

      if (!validatedUserId) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "User is not a member of this organization",
          }),
        );
      }
    }

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

    if (body.effectiveTo && body.effectiveTo < body.effectiveFrom) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "effectiveTo must be >= effectiveFrom",
        }),
      );
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

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${params.rateTableId}))`,
        );

        const totalEntries = await tx.$count(
          rateEntries,
          eq(rateEntries.rateTableId, params.rateTableId),
        );

        if (totalEntries >= LIMITS.rateEntriesPerTable) {
          return {
            ok: false as const,
            status: 400 as const,
            message: "Rate entries limit reached for this table",
          };
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
            message: "Date range overlaps with an existing entry for this user",
          };
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
          return {
            ok: false as const,
            status: 500 as const,
            message: "Failed to create rate entry",
          };
        }
        return { ok: true as const, id: entry.id };
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

    return Result.ok({ id: txResult.id });
  },
);

export default createRateEntry;
