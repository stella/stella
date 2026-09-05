import { Result } from "better-result";
import { and, eq, ne, sql } from "drizzle-orm";
import { t } from "elysia";

import { currencyMinorUnitDigits } from "@stll/money";

import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  tCurrencyCode,
  tDefaultVarchar,
  tSafeId,
} from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { pickDefined } from "@/api/lib/pick-defined";

const updateRateTableBodySchema = t.Object({
  id: tSafeId("rateTable"),
  name: t.Optional(tDefaultVarchar),
  currency: t.Optional(tCurrencyCode),
  isDefault: t.Optional(t.Boolean()),
});

const updateRateTable = createSafeHandler(
  {
    description:
      "Rename a rate table, change its currency, or make it the matter's " +
      "default, which clears the flag on the previous default. Unsetting the " +
      "flag on the only default table is refused, so a matter that has a " +
      "default keeps one; a matter whose tables were all created without the " +
      "flag has none, and rate resolution handles that. Rates already " +
      "recorded on time entries are not rewritten.",
    permissions: { rate: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    body: updateRateTableBodySchema,
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
            isDefault: true,
          },
        }),
      ),
    );

    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Rate table not found" }),
      );
    }

    const changedFields = pickDefined(body, ["name", "currency", "isDefault"]);
    const updates = {
      ...changedFields,
      updatedAt: new Date(),
    };

    // Prevent unsetting isDefault if no other default exists
    if (body.isDefault === false) {
      const otherDefaultRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: rateTables.id })
            .from(rateTables)
            .where(
              and(
                eq(rateTables.workspaceId, workspaceId),
                eq(rateTables.isDefault, true),
                ne(rateTables.id, body.id),
              ),
            )
            .limit(1),
        ),
      );
      const otherDefault = otherDefaultRows.at(0);

      if (!otherDefault) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Cannot unset default: no other default rate table exists",
          }),
        );
      }
    }

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // The currency the rates are currently stored in, read under a row
        // lock BEFORE anything is written. The `existing` read above happened
        // outside this transaction, so a currency change that landed in
        // between would leave this one scaling from a code the table no longer
        // carries; the lock also serializes two concurrent currency changes,
        // which would otherwise both scale from the same starting point.
        const lockedRows = await tx
          .select({ currency: rateTables.currency })
          .from(rateTables)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const sourceCurrency = lockedRows.at(0)?.currency ?? existing.currency;

        const nextCurrency = changedFields.currency;
        const exponentShift =
          nextCurrency === undefined || nextCurrency === sourceCurrency
            ? 0
            : currencyMinorUnitDigits(nextCurrency) -
              currencyMinorUnitDigits(sourceCurrency);

        // Three decimals from none multiplies by a thousand, so a rate well
        // inside the old currency's range can leave the range where a stored
        // integer still names itself. Refused here, before any write: the
        // column is `bigint` and would take the value, but the API reads it
        // back as a JSON number.
        if (exponentShift > 0) {
          const beyondRange = await tx
            .select({ id: rateEntries.id })
            .from(rateEntries)
            .where(
              and(
                eq(rateEntries.rateTableId, body.id),
                eq(rateEntries.workspaceId, workspaceId),
                sql`ABS(ROUND(${rateEntries.hourlyRate} * power(10::numeric, ${exponentShift}))) > ${Number.MAX_SAFE_INTEGER}`,
              ),
            )
            .limit(1);
          if (beyondRange.length > 0) {
            return { status: "rate-out-of-range" as const };
          }
        }

        const previousDefaults = body.isDefault
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

        await tx
          .update(rateTables)
          .set(updates)
          .where(
            and(
              eq(rateTables.id, body.id),
              eq(rateTables.workspaceId, workspaceId),
            ),
          );

        // A rate table's currency is the currency of every rate under it, and
        // a rate is stored in that currency's minor units. Changing the code
        // alone would restate every rate's value (10000 is 100.00 USD and
        // 10000 JPY), so the rates move with it, in this transaction. Rates
        // already copied onto time entries are not rewritten; those entries
        // carry the currency they were billed in.
        //
        // One set-based statement, not a CASE built from an earlier SELECT:
        // each row's own current value is what gets scaled, so a rate updated
        // between that read and this write is carried forward rather than
        // overwritten with the value it used to have. The shift is the same
        // for every row because both currencies are fixed, and `power` on
        // `numeric` keeps the arithmetic exact.
        if (exponentShift !== 0) {
          await tx
            .update(rateEntries)
            .set({
              hourlyRate: sql`ROUND(${rateEntries.hourlyRate} * power(10::numeric, ${exponentShift}))::bigint`,
            })
            .where(
              and(
                eq(rateEntries.rateTableId, body.id),
                eq(rateEntries.workspaceId, workspaceId),
              ),
            );
        }

        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const field of ["name", "currency", "isDefault"] as const) {
          const next = changedFields[field];
          if (next !== undefined) {
            // The currency's old value comes from the locked row, so the
            // audit trail records what was actually replaced.
            changes[field] = {
              old: field === "currency" ? sourceCurrency : existing[field],
              new: next,
            };
          }
        }

        const auditEvents = [
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
            resourceId: body.id,
            changes,
          },
        ];
        for (const row of previousDefaults) {
          if (row.id === body.id) {
            continue;
          }
          auditEvents.push({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.RATE_TABLE,
            resourceId: row.id,
            changes: {
              isDefault: { old: true, new: false },
            },
          });
        }

        await recordAuditEvent(tx, auditEvents);
        return { status: "updated" as const };
      }),
    );

    if (outcome.status === "rate-out-of-range") {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "A rate in this table cannot be restated in the new currency; " +
            "reduce it or re-enter the rates in that currency first",
        }),
      );
    }

    return Result.ok({ id: body.id });
  },
);

export default updateRateTable;
