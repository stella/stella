import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockMatterRates } from "@/api/lib/billing/rate-lock";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteRateTableBodySchema = t.Object({
  id: tSafeId("rateTable"),
});

const deleteRateTable = createSafeHandler(
  {
    description:
      "Permanently delete one rate table from a matter and, with it, every " +
      "per-user rate line it holds. The matter's default rate table is refused " +
      "until another table is made the default; time entries already recorded " +
      "keep the rate they were billed at.",
    permissions: { rate: ["delete"] },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: deleteRateTableBodySchema,
  },
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.rateTables.findFirst({
          where: { id: { eq: body.id }, workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            currency: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockMatterRates(tx, workspaceId);
        // The flag is decided under the lock that promoting a table takes, and
        // the delete repeats it, so a table promoted after the read above is
        // kept.
        const deleted = await tx
          .delete(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
              eq(rateTables.isDefault, false),
            ),
          )
          .returning({ id: rateTables.id });
        if (deleted.length === 0) {
          const remaining = await tx
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.id, body.id),
                eq(rateTables.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          return remaining.length === 0
            ? { status: "rate-not-found" as const }
            : { status: "is-default" as const };
        }

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

    if (outcome.status === "rate-not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }
    if (outcome.status === "is-default") {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Cannot delete the default rate table. " +
            "Set another table as default first.",
        }),
      );
    }

    return Result.ok({ deleted: true });
  },
);

export default deleteRateTable;
