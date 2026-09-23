import { Result } from "better-result";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { abortableTx } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  tMinorUnitAmount,
  tSafeId,
  tUserId,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const createRateEntryBodySchema = t.Object({
  userId: t.Optional(t.Nullable(tUserId)),
  hourlyRate: tMinorUnitAmount(0),
  effectiveFrom: t.String({ format: "date" }),
  effectiveTo: t.Optional(t.Nullable(t.String({ format: "date" }))),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: tSafeId("rateTable"),
});

const createRateEntry = createSafeHandler(
  {
    description:
      "Add one rate line to a rate table: an hourly rate in integer minor " +
      "currency units, effective from a date and optionally until another. " +
      "Pass userId for a person-specific rate or omit it for the table's " +
      "fallback rate. Refused when the date range overlaps an existing line " +
      "for the same user, when userId is not a member of the organization, " +
      "or when the table is at its line limit.",
    permissions: { rate: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: rateEntryParamsSchema,
    body: createRateEntryBodySchema,
  },
  async function* ({
    safeDb,
    workspaceId,
    session,
    params,
    body,
    recordAuditEvent,
  }) {
    if (body.userId) {
      const userId = body.userId;
      const validatedUserId = yield* Result.await(
        safeDb(
          async (tx) =>
            await validateOrgUserId(
              tx,
              brandPersistedUserId(userId),
              session.activeOrganizationId,
            ),
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
      abortableTx(safeDb, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${params.rateTableId}))`,
        );

        const totalEntries = await tx.$count(
          rateEntries,
          eq(rateEntries.rateTableId, params.rateTableId),
        );

        if (totalEntries >= LIMITS.rateEntriesPerTable) {
          throw new HandlerError({
            status: 400,
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
          throw new HandlerError({
            status: 400,
            message: "Date range overlaps with an existing entry for this user",
          });
        }

        const [entry] = await tx
          .insert(rateEntries)
          .values({
            workspaceId,
            rateTableId: params.rateTableId,
            userId: body.userId ?? null,
            hourlyRate: cents(body.hourlyRate),
            effectiveFrom: body.effectiveFrom,
            effectiveTo: body.effectiveTo ?? null,
          })
          .returning({ id: rateEntries.id });

        if (!entry) {
          throw new HandlerError({
            status: 500,
            message: "Failed to create rate entry",
          });
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_ENTRY,
          resourceId: entry.id,
          changes: {
            created: {
              old: null,
              new: {
                rateTableId: params.rateTableId,
                userId: body.userId ?? null,
                hourlyRate: cents(body.hourlyRate),
                effectiveFrom: body.effectiveFrom,
                effectiveTo: body.effectiveTo ?? null,
              },
            },
          },
        });

        return { id: entry.id };
      }),
    );

    return Result.ok({ id: txResult.id });
  },
);

export default createRateEntry;
