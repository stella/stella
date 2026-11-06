import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { currencyCodeSchema } from "@stll/api-contract/currency-code";

import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import { rateTables } from "@/api/db/schema";
import { rateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { displayNameSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const createRateTableBodySchema = v.object({
  name: displayNameSchema(),
  currency: currencyCodeSchema,
  isDefault: v.optional(v.boolean()),
});

export type CreateRateTableHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: v.InferOutput<typeof createRateTableBodySchema>;
  recordAuditEvent: AuditRecorder;
};

// Shared rate-table creation reused by the HTTP handler and the review
// organization seed, so both lock, cap and audit the same way.
export const createRateTableHandler = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  body,
  recordAuditEvent,
}: CreateRateTableHandlerProps) {
  const txResult = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      // Row locks cannot serialize the first table in an empty matter.
      await withAggregateLock({
        aggregate: "rateTableWorkspace",
        id: { workspaceId },
        tx,
      });
      // Every rate-table write in the matter holds the lock above, so this
      // read stays current until the insert commits.
      const lockedRows = await tx
        .select({ id: rateTables.id, isDefault: rateTables.isDefault })
        .from(rateTables)
        .where(eq(rateTables.workspaceId, workspaceId));

      if (lockedRows.length >= LIMITS.rateTablesPerWorkspace) {
        throw new HandlerError({
          status: 400,
          message: "Rate tables limit reached for this workspace",
        });
      }

      // Rates resolve only from a matter's default table, so a matter that
      // has tables always has exactly one default: a table created while the
      // matter has none becomes the default whatever the request asked.
      const isDefault =
        body.isDefault === true || !lockedRows.some((row) => row.isDefault);

      const previousDefaults = isDefault
        ? await tx
            .update(rateTables)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
              ),
            )
            .returning({ id: rateTables.id })
        : [];

      const [table] = await tx
        .insert(rateTables)
        .values({
          organizationId,
          workspaceId,
          name: body.name,
          currency: body.currency,
          isDefault,
        })
        .returning({ id: rateTables.id });

      if (!table) {
        // The insert cleared the workspace's previous default table above, so
        // returning here would commit a workspace with no default at all.
        throw new HandlerError({
          status: 500,
          message: "Failed to create rate table",
        });
      }

      await recordAuditEvent(tx, [
        {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
          resourceId: table.id,
          changes: {
            created: {
              old: null,
              new: {
                name: body.name,
                currency: body.currency,
                isDefault,
              },
            },
          },
        },
        ...previousDefaults.map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
          resourceId: row.id,
          changes: {
            isDefault: { old: true, new: false },
          },
        })),
      ]);

      return { id: table.id };
    }),
  );

  return Result.ok({ id: txResult.id });
};

const createRateTable = createSafeHandler(
  {
    contract: "patch",
    idempotency: { type: "replay" },
    description:
      "Create a rate table, a named set of hourly rates in a single " +
      "currency, in a matter. Rates apply only from the matter's default " +
      "table. Pass isDefault to make it the default, which clears the flag " +
      "on the previous default; a table created while the matter has no " +
      "default becomes the default. Matters have a fixed cap on how many " +
      "rate tables they may hold. Add the rates " +
      "themselves with rates.entries.create.",
    permissions: { rate: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: rateRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: createRateTableBodySchema,
  },
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* createRateTableHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      body,
      recordAuditEvent,
    });
  },
);

export default createRateTable;
