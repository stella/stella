import { Result } from "better-result";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { todayFor } from "@stll/time";

import {
  BILLING_STATUS,
  billingArrangements,
  expenses,
  timeEntries,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { resolveInvoicePrefill } from "@/api/lib/billing/invoice-prefill";
import { latestDate } from "@/api/lib/billing/invoice-prefill.logic";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/lib/billing/timekeeper-names";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/** One invoice holds at most this many entries; `invoices.create` accepts as many. */
const PREFILL_ENTRY_LIMIT = 500;

const mostCommon = (values: readonly string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [value, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = value;
    }
  }
  return best;
};

const prefillInvoice = createSafeHandler(
  {
    contract: "patch",
    description:
      "Prepare a new invoice for a matter without creating it: the matter's " +
      "approved, billable, not-yet-invoiced time entries (with timekeeper names) " +
      "and approved billable expenses, oldest first (a matter with more than 500 of either is refused); the proposed " +
      "currency, issue date (today in the organization's zone) and payment term; " +
      "the default seller profile (or sellerProfileId); the buyer copied from " +
      "the matter's client; the VAT treatment and rate the lines would get, " +
      "each with where it came from; and the organization's VAT rate periods, " +
      "since billing fewer items can move the supply date into another rate. " +
      "Pass the chosen ids to invoices.create, which applies the same prefill.",
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
    query: v.object({
      sellerProfileId: v.optional(resourceIdSchema("sellerProfile")),
    }),
  },
  async function* ({ safeDb, session, workspaceId, query }) {
    const organizationId = session.activeOrganizationId;
    const loaded = yield* Result.await(
      safeDb(async (tx) => {
        const [entryRead, expenseRead, arrangement, timeZone] =
          await Promise.all([
            readBounded(
              tx
                .select({
                  id: timeEntries.id,
                  userId: timeEntries.userId,
                  dateWorked: timeEntries.dateWorked,
                  durationMinutes: timeEntries.durationMinutes,
                  billedMinutes: timeEntries.billedMinutes,
                  rateAtEntry: timeEntries.rateAtEntry,
                  currency: timeEntries.currency,
                  narrative: timeEntries.narrative,
                  invoiceNarrative: timeEntries.invoiceNarrative,
                  noCharge: timeEntries.noCharge,
                  taskCode: timeEntries.taskCode,
                  activityCode: timeEntries.activityCode,
                })
                .from(timeEntries)
                .where(
                  and(
                    eq(timeEntries.workspaceId, workspaceId),
                    eq(
                      timeEntries.activityGroup,
                      TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
                    ),
                    eq(timeEntries.status, BILLING_STATUS.APPROVED),
                    eq(timeEntries.billable, true),
                    isNull(timeEntries.invoiceId),
                    ne(timeEntries.currency, UNPRICED_TIME_ENTRY_CURRENCY),
                  ),
                )
                .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id)),
              PREFILL_ENTRY_LIMIT,
            ),
            readBounded(
              tx
                .select({
                  id: expenses.id,
                  dateIncurred: expenses.dateIncurred,
                  amount: expenses.amount,
                  markup: expenses.markup,
                  currency: expenses.currency,
                  category: expenses.category,
                  description: expenses.description,
                  invoiceDescription: expenses.invoiceDescription,
                })
                .from(expenses)
                .where(
                  and(
                    eq(expenses.workspaceId, workspaceId),
                    eq(expenses.status, BILLING_STATUS.APPROVED),
                    eq(expenses.billable, true),
                    isNull(expenses.invoiceId),
                  ),
                )
                .orderBy(asc(expenses.dateIncurred), asc(expenses.id)),
              PREFILL_ENTRY_LIMIT,
            ),
            tx
              .select({
                mode: billingArrangements.mode,
                currency: billingArrangements.currency,
                flatFeeAmount: billingArrangements.flatFeeAmount,
              })
              .from(billingArrangements)
              .where(eq(billingArrangements.workspaceId, workspaceId))
              .limit(1),
            readOrganizationTimeZone(tx, organizationId),
          ]);
        if (entryRead.type === "overflow" || expenseRead.type === "overflow") {
          return null;
        }
        const shownEntries = entryRead.rows;
        const shownExpenses = expenseRead.rows;
        const userIds = timekeeperIdsOf(shownEntries);
        const names =
          userIds.size === 0
            ? []
            : await selectTimekeeperNames(tx, { organizationId, userIds });
        const invoiceDate = todayFor(timeZone).toString();
        const supplyDate = latestDate(
          [
            ...shownEntries.map((entry) => entry.dateWorked),
            ...shownExpenses.map((expense) => expense.dateIncurred),
          ],
          invoiceDate,
        );
        const prefill = await resolveInvoicePrefill(tx, {
          organizationId,
          workspaceId,
          sellerProfileId: query.sellerProfileId,
          supplyDate,
        });
        return {
          shownEntries,
          shownExpenses,
          arrangement: arrangement.at(0) ?? null,
          names: new Map(names.map((row) => [row.id, row.name])),
          invoiceDate,
          supplyDate,
          prefill,
        };
      }),
    );
    if (loaded === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "too_many_unbilled_items",
          message: `This matter has more than ${PREFILL_ENTRY_LIMIT} unbilled time entries or expenses; an invoice bills at most ${PREFILL_ENTRY_LIMIT} of each`,
          hint: `Read the matter's approved entries with time-entries.list and call invoices.create with up to ${PREFILL_ENTRY_LIMIT} timeEntryIds at a time.`,
        }),
      );
    }
    const { prefill, arrangement } = loaded;
    const currency =
      arrangement?.currency ??
      mostCommon(loaded.shownEntries.map((entry) => entry.currency)) ??
      mostCommon(loaded.shownExpenses.map((expense) => expense.currency)) ??
      prefill.seller?.defaultCurrency ??
      prefill.clientCurrency;
    return Result.ok({
      currency,
      language: prefill.language,
      invoiceDate: loaded.invoiceDate,
      taxableSupplyDate: loaded.supplyDate,
      dueDays: prefill.dueDays,
      dueDaysSource: prefill.dueDaysSource,
      seller:
        prefill.seller === null
          ? null
          : {
              id: prefill.seller.id,
              legalName: prefill.seller.legalName,
              vatId: prefill.seller.vatId,
              vatPayer: prefill.seller.vatPayer,
              defaultCurrency: prefill.seller.defaultCurrency,
            },
      sellerSource: prefill.sellerSource,
      buyer: prefill.buyer,
      buyerSource: prefill.buyerSource,
      vat: prefill.vat,
      vatRatePeriods: prefill.vatRatePeriods,
      billingMode: arrangement?.mode ?? "hourly",
      flatFeeAmount:
        arrangement?.mode === "flat_fee" ? arrangement.flatFeeAmount : null,
      timeEntries: loaded.shownEntries.map((entry) => ({
        ...entry,
        timekeeperName:
          entry.userId === null
            ? null
            : (loaded.names.get(entry.userId) ?? null),
      })),
      expenses: loaded.shownExpenses,
    });
  },
);

export default prefillInvoice;
