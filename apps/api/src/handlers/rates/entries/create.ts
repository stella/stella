import { Result } from "better-result";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";
import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { rateEntries } from "@/api/db/schema";
import { rateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  minorUnitAmountSchema,
  resourceIdSchema,
  userIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

import {
  lockLegacyRateEntryTable,
  lockRateTableWorkspace,
} from "../rate-table-lock";

const createRateEntryBodySchema = v.object({
  userId: v.optional(v.nullable(userIdSchema)),
  // The canonical role tuple, so adding a role cannot silently omit it here.
  role: v.optional(v.nullable(v.picklist(ORGANIZATION_ROLE_NAMES))),
  currency: currencyCodeSchema,
  hourlyRate: minorUnitAmountSchema(0),
  effectiveFrom: apiDateSchema,
  effectiveTo: v.optional(v.nullable(apiDateSchema)),
});

const rateEntryParamsSchema = workspaceParams({
  rateTableId: resourceIdSchema("rateTable"),
});

export type CreateRateEntryHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  session: { activeOrganizationId: SafeId<"organization"> };
  params: { rateTableId: SafeId<"rateTable"> };
  body: v.InferOutput<typeof createRateEntryBodySchema>;
  recordAuditEvent: AuditRecorder;
};

// Shared rate-line creation reused by the HTTP handler and the review
// organization seed, so both validate, cap and audit the same way.
export const createRateEntryHandler = async function* ({
  safeDb,
  workspaceId,
  session,
  params,
  body,
  recordAuditEvent,
}: CreateRateEntryHandlerProps) {
  const selectedUserId = body.userId ?? null;
  const selectedRole = body.role ?? null;
  if (selectedUserId !== null && selectedRole !== null) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Choose a person or a role, not both",
      }),
    );
  }
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
    selectedRole === null
      ? isNull(rateEntries.role)
      : eq(rateEntries.role, selectedRole),
    overlapToCondition,
  ];
  if (overlapFromCondition) {
    overlapConditions.push(overlapFromCondition);
  }

  const txResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      await lockRateTableWorkspace(tx, workspaceId);
      const table = await tx.query.rateTables.findFirst({
        where: {
          id: { eq: params.rateTableId },
          workspaceId: { eq: workspaceId },
        },
        columns: { currency: true },
      });
      if (!table) {
        return abortTransaction(
          new HandlerError({
            status: 404,
            message: "Rate table not found",
          }),
        );
      }
      if (table.currency !== body.currency) {
        return abortTransaction(
          new HandlerError({
            status: 409,
            code: "rate_table_currency_changed",
            hint: "Call rates.list, then retry rates.entries.create with the table's current currency.",
            message: "Rate table currency changed; reload and try again",
          }),
        );
      }
      await lockLegacyRateEntryTable(tx, params.rateTableId);

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
          message:
            "Date range overlaps with an existing entry for this person, role, or table default",
        });
      }

      const [entry] = await tx
        .insert(rateEntries)
        .values({
          workspaceId,
          rateTableId: params.rateTableId,
          userId: body.userId ?? null,
          role: body.role ?? null,
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
              role: body.role ?? null,
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
};

const createRateEntry = createSafeHandler(
  {
    contract: "patch",
    description:
      "Add one rate line to a rate table: an hourly rate in integer minor " +
      "currency units, naming the table currency those units use, effective from a date and optionally until another. " +
      "Pass userId for a person-specific rate, role for an organization-role rate, " +
      "or omit both for the table fallback. Set at most one selector. " +
      "Refused when dates overlap a line for the same selector or userId is not an organization member, " +
      "or when the table is at its line limit. A stale currency is refused; call rates.list and retry with the table's current currency.",
    permissions: { rate: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: rateRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: rateEntryParamsSchema,
    body: createRateEntryBodySchema,
  },
  async function* (context) {
    return yield* createRateEntryHandler(context);
  },
);

export default createRateEntry;
