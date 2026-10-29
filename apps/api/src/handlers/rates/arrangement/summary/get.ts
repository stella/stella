import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { billingArrangements } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { readBillingUsage } from "@/api/lib/billing/arrangements";
import { evaluateBillingArrangementCaps } from "@/api/lib/billing/arrangements.logic";

const readMatterBillingSummary = createSafeHandler(
  {
    contract: "patch",
    description:
      "Read matter time billing usage: non-void invoice time-line net reservations (including drafts) plus approved unbilled client time, in one currency. Amounts are exact decimal minor-unit strings. Currency mismatch makes cap status unavailable; the summary field is null when no arrangement exists; configure one with rates.arrangement.update. remainingInvoiceCapAmount excludes approved unbilled work; remainingWipCapAmount includes it. No events are emitted by reads.",
    permissions: { rate: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
  },
  async function* ({ safeDb, workspaceId }) {
    const summary = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select()
          .from(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId));
        const arrangement = rows.at(0);
        if (!arrangement) {
          return null;
        }
        const usage = await readBillingUsage(tx, {
          workspaceId,
          currency: arrangement.currency,
        });
        const minuteUsage = {
          billedMinutes: usage.billedMinutes.toString(),
          approvedMinutes: usage.approvedMinutes.toString(),
          totalMinutes: usage.totalMinutes.toString(),
        };
        if (usage.currencyMismatch) {
          return {
            status: "currency_mismatch",
            ...minuteUsage,
            currency: arrangement.currency,
            mismatchCount: usage.mismatchCount.toString(),
            capStatus: "unavailable",
          } as const;
        }
        const amounts = {
          ...minuteUsage,
          currency: arrangement.currency,
          billedAmount: usage.billedAmount.toString(),
          approvedAmount: usage.approvedAmount.toString(),
          totalAmount: usage.totalAmount.toString(),
        };
        if (
          arrangement.mode !== "hourly" ||
          (arrangement.capAmount === null && arrangement.capMinutes === null)
        ) {
          return { status: "uncapped", ...amounts } as const;
        }
        const alertThresholdBps =
          arrangement.alertThresholdBps ??
          panic("Capped arrangement has no threshold");
        const cap =
          arrangement.capAmount === null ? null : BigInt(arrangement.capAmount);
        const minuteCap =
          arrangement.capMinutes === null
            ? null
            : BigInt(arrangement.capMinutes);
        const { amount: state, minutes } = evaluateBillingArrangementCaps({
          totalAmount: usage.totalAmount,
          totalMinutes: usage.totalMinutes,
          capAmount: arrangement.capAmount,
          capMinutes: arrangement.capMinutes,
          alertThresholdBps,
        });
        const capAmounts = {
          ...amounts,
          ...(cap === null
            ? {}
            : {
                capAmount: cap.toString(),
                remainingWipCapAmount: (cap > usage.totalAmount
                  ? cap - usage.totalAmount
                  : 0n
                ).toString(),
                remainingInvoiceCapAmount: (cap > usage.billedAmount
                  ? cap - usage.billedAmount
                  : 0n
                ).toString(),
              }),
          ...(minuteCap === null
            ? {}
            : {
                capMinutes: minuteCap.toString(),
                remainingWipCapMinutes: (minuteCap > usage.totalMinutes
                  ? minuteCap - usage.totalMinutes
                  : 0n
                ).toString(),
                remainingInvoiceCapMinutes: (minuteCap > usage.billedMinutes
                  ? minuteCap - usage.billedMinutes
                  : 0n
                ).toString(),
              }),
          alertThresholdBps,
        };
        if (state.capState === "above" || minutes.capState === "above") {
          return { status: "cap_reached", ...capAmounts } as const;
        }
        if (
          state.thresholdState === "above" ||
          minutes.thresholdState === "above"
        ) {
          return { status: "threshold_reached", ...capAmounts } as const;
        }
        return { status: "below_threshold", ...capAmounts } as const;
      }),
    );
    return Result.ok({ summary });
  },
);

export default readMatterBillingSummary;
