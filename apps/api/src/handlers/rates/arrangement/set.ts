import { panic, Result } from "better-result";
import { t } from "elysia";

import { billingArrangements } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  billingArrangementResponse,
  lockBillingArrangement,
  readBillingUsage,
  recordBillingCapCrossings,
} from "@/api/lib/billing/arrangements";
import { tCurrencyCode, tMinorUnitAmount } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";

const setBillingArrangement = createSafeHandler(
  {
    description:
      "Set the matter's current billing arrangement in integer minor currency units. Hourly supports an optional positive cap and alert threshold in basis points; flat fee supplies one amount. Refused for mixed-currency existing charged work or a cap below reserved invoice time. Changes do not change invoice snapshots.",
    permissions: { rate: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    body: t.Union([
      t.Object(
        {
          mode: t.Literal("hourly"),
          currency: tCurrencyCode,
          revision: t.Optional(t.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
      t.Object(
        {
          mode: t.Literal("hourly"),
          currency: tCurrencyCode,
          revision: t.Optional(t.Integer({ minimum: 1 })),
          capAmount: tMinorUnitAmount(1),
          alertThresholdBps: t.Integer({ minimum: 1, maximum: 10_000 }),
        },
        { additionalProperties: false },
      ),
      t.Object(
        {
          mode: t.Literal("flat_fee"),
          currency: tCurrencyCode,
          revision: t.Optional(t.Integer({ minimum: 1 })),
          flatFeeAmount: tMinorUnitAmount(0),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  async function* ({ body, safeDb, workspaceId, session, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const previous = await lockBillingArrangement(tx, workspaceId);
        if (
          body.revision !== undefined &&
          body.revision !== previous?.revision
        ) {
          return Result.err(
            new HandlerError({
              status: 409,
              code: "billing_arrangement_stale",
              hint: "Call rates.arrangement.get, then retry rates.arrangement.set with the returned revision.",
              message: "Billing arrangement changed; reload and try again",
            }),
          );
        }
        const usage = await readBillingUsage(tx, {
          workspaceId,
          currency: body.currency,
        });
        if (usage.currencyMismatch) {
          return Result.err(
            new HandlerError({
              status: 409,
              code: "billing_currency_mismatch",
              hint: "Call rates.arrangement.summary and rates.arrangement.get; align the existing charged work currency before retrying rates.arrangement.set.",
              message: "Existing charged work uses a different currency",
            }),
          );
        }
        const capAmount =
          body.mode === "hourly" && "capAmount" in body
            ? cents(body.capAmount)
            : null;
        if (capAmount !== null && usage.billedAmount > BigInt(capAmount)) {
          return Result.err(
            new HandlerError({
              status: 409,
              code: "billing_cap_below_reserved",
              hint: "Call rates.arrangement.summary, then retry rates.arrangement.set with a cap at least as large as billedAmount.",
              message: "Billing cap is below reserved invoice time",
            }),
          );
        }
        const values = {
          organizationId: session.activeOrganizationId,
          workspaceId,
          mode: body.mode,
          currency: body.currency,
          flatFeeAmount:
            body.mode === "flat_fee" ? cents(body.flatFeeAmount) : null,
          capAmount,
          alertThresholdBps:
            body.mode === "hourly" && "alertThresholdBps" in body
              ? body.alertThresholdBps
              : null,
          thresholdState: "below",
          capState: "below",
          currencyState: "matched",
          crossingSequence: previous?.crossingSequence ?? 0,
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: new Date(),
        } as const;
        if (
          previous &&
          previous.mode === values.mode &&
          previous.currency === values.currency &&
          previous.flatFeeAmount === values.flatFeeAmount &&
          previous.capAmount === values.capAmount &&
          previous.alertThresholdBps === values.alertThresholdBps
        ) {
          return Result.ok(billingArrangementResponse(previous));
        }
        const rows = await tx
          .insert(billingArrangements)
          .values(values)
          .onConflictDoUpdate({
            target: billingArrangements.workspaceId,
            set: values,
          })
          .returning({
            mode: billingArrangements.mode,
            currency: billingArrangements.currency,
            flatFeeAmount: billingArrangements.flatFeeAmount,
            capAmount: billingArrangements.capAmount,
            alertThresholdBps: billingArrangements.alertThresholdBps,
            revision: billingArrangements.revision,
          });
        const arrangement =
          rows.at(0) ?? panic("Arrangement upsert returned no row");
        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
            resourceId: workspaceId,
            workspaceId,
            changes: {
              billingArrangement: {
                old: previous
                  ? {
                      mode: previous.mode,
                      currency: previous.currency,
                      flatFeeAmount: previous.flatFeeAmount,
                      capAmount: previous.capAmount,
                      alertThresholdBps: previous.alertThresholdBps,
                      revision: previous.revision,
                    }
                  : null,
                new: arrangement,
              },
            },
          },
        ]);
        await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });
        return Result.ok(billingArrangementResponse(arrangement));
      }),
    );
    return outcome;
  },
);

export default setBillingArrangement;
