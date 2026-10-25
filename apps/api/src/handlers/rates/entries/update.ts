import { panic, Result } from "better-result";
import { and, eq, gte, isNull, lte, ne, or } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";

import { rateEntries } from "@/api/db/schema";
import { rateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  minorUnitAmountSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

import {
  lockLegacyRateEntryTable,
  lockRateTableWorkspace,
} from "../rate-table-lock";

const updateRateEntryBodySchema = v.object({
  id: resourceIdSchema("rateEntry"),
  currency: currencyCodeSchema,
  hourlyRate: v.optional(minorUnitAmountSchema(0)),
  effectiveFrom: v.optional(apiDateSchema),
  effectiveTo: v.optional(v.nullable(apiDateSchema)),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: resourceIdSchema("rateTable"),
});

const updateRateEntry = createSafeHandler(
  {
    contract: "patch",
    description:
      "Change one rate line's hourly rate or effective dates in a rate " +
      "table, naming the table currency its minor units use. Changing the dates re-checks for overlap against the other " +
      "lines for the same person, role, or table default and is refused on a conflict; the selector a line " +
      "applies to cannot be changed here. A stale currency is refused; call rates.list and retry with the table's current currency.",
    permissions: { rate: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: rateRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: rateEntryParamsSchema,
    body: updateRateEntryBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    const updates = {
      ...pickDefined(body, ["effectiveFrom", "effectiveTo"]),
      ...(body.hourlyRate !== undefined
        ? { hourlyRate: cents(body.hourlyRate) }
        : {}),
    };

    const datesChanged =
      body.effectiveFrom !== undefined || body.effectiveTo !== undefined;

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockRateTableWorkspace(tx, workspaceId);
        // Previous builds create entries under this lock alone.
        await lockLegacyRateEntryTable(tx, params.rateTableId);
        const table = await tx.query.rateTables.findFirst({
          where: {
            id: { eq: params.rateTableId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currency: true },
        });
        if (!table) {
          return { status: "table-not-found" as const };
        }
        if (table.currency !== body.currency) {
          return { status: "currency-changed" as const };
        }

        const lockedRows = await tx
          .select({
            userId: rateEntries.userId,
            role: rateEntries.role,
            hourlyRate: rateEntries.hourlyRate,
            effectiveFrom: rateEntries.effectiveFrom,
            effectiveTo: rateEntries.effectiveTo,
          })
          .from(rateEntries)
          .where(
            and(
              eq(rateEntries.id, body.id),
              eq(rateEntries.rateTableId, params.rateTableId),
            ),
          );
        const locked = lockedRows.at(0);
        if (!locked) {
          return { status: "entry-not-found" as const };
        }

        if (Object.keys(updates).length === 0) {
          return { status: "updated" as const };
        }

        if (datesChanged) {
          const resolvedFrom = body.effectiveFrom ?? locked.effectiveFrom;
          const resolvedTo =
            body.effectiveTo !== undefined
              ? body.effectiveTo
              : locked.effectiveTo;

          if (resolvedTo && resolvedTo < resolvedFrom) {
            return { status: "invalid-range" as const };
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
            locked.role === null
              ? isNull(rateEntries.role)
              : eq(rateEntries.role, locked.role),
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
            return { status: "overlap" as const };
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
            changes[field] = { old: locked[field] ?? null, new: next };
          }
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_ENTRY,
          resourceId: body.id,
          changes,
        });

        return { status: "updated" as const };
      }),
    );

    switch (outcome.status) {
      case "table-not-found":
        return Result.err(
          new HandlerError({ status: 404, message: "Rate table not found" }),
        );
      case "currency-changed":
        return Result.err(
          new HandlerError({
            status: 409,
            code: "rate_table_currency_changed",
            hint: "Call rates.list, then retry rates.entries.update with the table's current currency.",
            message: "Rate table currency changed; reload and try again",
          }),
        );
      case "entry-not-found":
        return Result.err(
          new HandlerError({ status: 404, message: "Rate entry not found" }),
        );
      case "invalid-range":
        return Result.err(
          new HandlerError({
            status: 400,
            message: "effectiveTo must be >= effectiveFrom",
          }),
        );
      case "overlap":
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "Date range overlaps with an existing entry for this person, role, or table default",
          }),
        );
      case "updated":
        return Result.ok({ id: body.id });
      default: {
        outcome satisfies never;
        return panic("Unknown rate-entry update outcome");
      }
    }
  },
);

export default updateRateEntry;
