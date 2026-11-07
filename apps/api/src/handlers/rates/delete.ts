import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";
import * as v from "valibot";

import { rateTables } from "@/api/db/schema";
import { rateRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteRateTableBodySchema = v.object({
  id: resourceIdSchema("rateTable"),
});

const deleteRateTable = createSafeHandler(
  {
    contract: "patch",
    description:
      "Permanently delete one rate table from a matter and, with it, every " +
      "per-user rate line it holds. While the matter has other tables, its " +
      "default table is refused until another table is made the default; " +
      "the matter's last table can always be deleted. Time entries already " +
      "recorded keep the rate they were billed at.",
    permissions: { rate: ["delete"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: rateRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: deleteRateTableBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // The matter lock that creating and updating a table take, so the
        // default decided here cannot change before this delete commits.
        await withAggregateLock({
          aggregate: "rateTableWorkspace",
          id: { workspaceId },
          tx,
        });
        const [existing] = await tx
          .select({
            name: rateTables.name,
            currency: rateTables.currency,
            isDefault: rateTables.isDefault,
          })
          .from(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );

        if (!existing) {
          return { status: "not-found" as const };
        }

        // A matter with tables keeps exactly one default, so the default may
        // go only when it is the last table.
        if (existing.isDefault) {
          const [otherTable] = await tx
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                ne(rateTables.id, body.id),
              ),
            )
            .limit(1);
          if (otherTable) {
            return { status: "default-with-others" as const };
          }
        }

        await tx
          .delete(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
          resourceId: body.id,
          changes: {
            deleted: {
              old: {
                name: existing.name,
                currency: existing.currency,
              },
              new: null,
            },
          },
        });
        return { status: "deleted" as const };
      }),
    );

    if (outcome.status === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }
    if (outcome.status === "default-with-others") {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Cannot delete the default rate table while the matter has " +
            "other tables. Set another table as default first.",
        }),
      );
    }

    return Result.ok({ deleted: true });
  },
);

export default deleteRateTable;
