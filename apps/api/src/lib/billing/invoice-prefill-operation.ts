import { panic, Result } from "better-result";
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { todayFor } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  BILLING_STATUS,
  billingArrangements,
  expenses,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import {
  readInvoicePrefillContext,
  resolveInvoicePrefillContext,
} from "@/api/lib/billing/invoice-prefill";
import { latestDate } from "@/api/lib/billing/invoice-prefill.logic";
import {
  selectTimekeeperNames,
  timekeeperIdsOf,
} from "@/api/lib/billing/timekeeper-names";
import type { SafeId } from "@/api/lib/branded-types";
import { readBoundedByGroup } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";

/** One invoice holds at most this many entries; `invoices.create` accepts as many. */
const PREFILL_ENTRY_LIMIT = LIMITS.invoiceSourceItemsPerKind;

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

type MatterPrefillOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  periodStart?: string | undefined;
  periodEnd?: string | undefined;
  sellerProfileId?: SafeId<"sellerProfile"> | undefined;
};
type MatterPrefillsOptions = Omit<MatterPrefillOptions, "workspaceId"> & {
  workspaceIds: readonly SafeId<"workspace">[];
};

const readInvoicePrefillSources = async (
  tx: Transaction,
  {
    organizationId,
    workspaceIds,
    sellerProfileId,
    periodStart,
    periodEnd,
  }: MatterPrefillsOptions,
) => {
  // Each lateral scan reads only its matter's first LIMIT+1 eligible rows;
  // truncation is refused before projection, including on the last matter.
  const eligibleEntries = tx
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
        eq(timeEntries.workspaceId, workspaces.id),
        periodStart ? gte(timeEntries.dateWorked, periodStart) : undefined,
        periodEnd ? lte(timeEntries.dateWorked, periodEnd) : undefined,
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        eq(timeEntries.status, BILLING_STATUS.APPROVED),
        eq(timeEntries.billable, true),
        isNull(timeEntries.invoiceId),
        ne(timeEntries.currency, UNPRICED_TIME_ENTRY_CURRENCY),
      ),
    )
    .orderBy(asc(timeEntries.dateWorked), asc(timeEntries.id));
  const eligibleExpenses = tx
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
        eq(expenses.workspaceId, workspaces.id),
        periodStart ? gte(expenses.dateIncurred, periodStart) : undefined,
        periodEnd ? lte(expenses.dateIncurred, periodEnd) : undefined,
        eq(expenses.status, BILLING_STATUS.APPROVED),
        eq(expenses.billable, true),
        isNull(expenses.invoiceId),
      ),
    )
    .orderBy(asc(expenses.dateIncurred), asc(expenses.id));
  const selectedMatters = and(
    eq(workspaces.organizationId, organizationId),
    inArray(workspaces.id, workspaceIds),
  );
  const [entries, expenseRows, arrangements, timeZone, context] =
    await Promise.all([
      readBoundedByGroup(eligibleEntries, {
        cap: PREFILL_ENTRY_LIMIT,
        readRows: (limited) => {
          const limitedEntries = limited.as("prefill_entries");
          return tx
            .select({
              workspaceId: workspaces.id,
              entry: {
                id: limitedEntries.id,
                userId: limitedEntries.userId,
                dateWorked: limitedEntries.dateWorked,
                durationMinutes: limitedEntries.durationMinutes,
                billedMinutes: limitedEntries.billedMinutes,
                rateAtEntry: limitedEntries.rateAtEntry,
                currency: limitedEntries.currency,
                narrative: limitedEntries.narrative,
                invoiceNarrative: limitedEntries.invoiceNarrative,
                noCharge: limitedEntries.noCharge,
                taskCode: limitedEntries.taskCode,
                activityCode: limitedEntries.activityCode,
              },
            })
            .from(workspaces)
            .innerJoinLateral(limitedEntries, sql`true`)
            .where(selectedMatters)
            .orderBy(
              workspaces.id,
              limitedEntries.dateWorked,
              limitedEntries.id,
            )
            .limit(workspaceIds.length * (PREFILL_ENTRY_LIMIT + 1));
        },
        groupKeyOf: (row) => row.workspaceId,
      }),
      readBoundedByGroup(eligibleExpenses, {
        cap: PREFILL_ENTRY_LIMIT,
        readRows: (limited) => {
          const limitedExpenses = limited.as("prefill_expenses");
          return tx
            .select({
              workspaceId: workspaces.id,
              expense: {
                id: limitedExpenses.id,
                dateIncurred: limitedExpenses.dateIncurred,
                amount: limitedExpenses.amount,
                markup: limitedExpenses.markup,
                currency: limitedExpenses.currency,
                category: limitedExpenses.category,
                description: limitedExpenses.description,
                invoiceDescription: limitedExpenses.invoiceDescription,
              },
            })
            .from(workspaces)
            .innerJoinLateral(limitedExpenses, sql`true`)
            .where(selectedMatters)
            .orderBy(
              workspaces.id,
              limitedExpenses.dateIncurred,
              limitedExpenses.id,
            )
            .limit(workspaceIds.length * (PREFILL_ENTRY_LIMIT + 1));
        },
        groupKeyOf: (row) => row.workspaceId,
      }),
      tx
        .select({
          workspaceId: billingArrangements.workspaceId,
          mode: billingArrangements.mode,
          currency: billingArrangements.currency,
          flatFeeAmount: billingArrangements.flatFeeAmount,
        })
        .from(billingArrangements)
        .where(inArray(billingArrangements.workspaceId, workspaceIds))
        .limit(workspaceIds.length),
      readOrganizationTimeZone(tx, organizationId),
      readInvoicePrefillContext(tx, {
        organizationId,
        workspaceIds,
        sellerProfileId,
      }),
    ]);
  return { entries, expenseRows, arrangements, timeZone, context };
};

/** Every source query receives the already authorized, bounded matter set. */
export const readMatterInvoicePrefills = async (
  tx: Transaction,
  options: MatterPrefillsOptions,
) => {
  const { organizationId, workspaceIds } = options;
  if (workspaceIds.length > LIMITS.clientInvoiceMatters) {
    panic("Invoice prefill matter selection exceeds its bound");
  }
  const {
    entries: entryRead,
    expenseRows: expenseRead,
    arrangements,
    timeZone,
    context,
  } = await readInvoicePrefillSources(tx, options);
  if (entryRead.type === "overflow" || expenseRead.type === "overflow") {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "too_many_unbilled_items",
        message: `This matter has more than ${PREFILL_ENTRY_LIMIT} unbilled time entries or expenses; an invoice bills at most ${PREFILL_ENTRY_LIMIT} of each`,
        hint: `Read the matter's approved entries with time-entries.list and call invoices.create with up to ${PREFILL_ENTRY_LIMIT} timeEntryIds at a time.`,
      }),
    );
  }
  const entries = entryRead.rows;
  const expenseRows = expenseRead.rows;
  const entriesByMatter = Map.groupBy(entries, (row) => row.workspaceId);
  const expensesByMatter = Map.groupBy(expenseRows, (row) => row.workspaceId);
  const userIds = timekeeperIdsOf(entries.map(({ entry }) => entry));
  const names =
    userIds.size === 0
      ? []
      : await selectTimekeeperNames(tx, { organizationId, userIds });
  const namesById = new Map(names.map((row) => [row.id, row.name]));
  const arrangementsByMatter = new Map(
    arrangements.map((row) => [row.workspaceId, row]),
  );
  const invoiceDate = todayFor(timeZone).toString();
  const prefills = workspaceIds.map((workspaceId: SafeId<"workspace">) => {
    const shownEntries = arrayOrEmpty(entriesByMatter.get(workspaceId)).map(
      ({ entry }) => entry,
    );
    const shownExpenses = arrayOrEmpty(expensesByMatter.get(workspaceId)).map(
      ({ expense }) => expense,
    );
    const supplyDate = latestDate(
      [
        ...shownEntries.map((entry) => entry.dateWorked),
        ...shownExpenses.map((expense) => expense.dateIncurred),
      ],
      invoiceDate,
    );
    const loaded = {
      shownEntries,
      shownExpenses,
      names: namesById,
      arrangement: arrangementsByMatter.get(workspaceId) ?? null,
      invoiceDate,
      supplyDate,
      prefill: resolveInvoicePrefillContext(context, {
        workspaceId,
        supplyDate,
      }),
    };
    const { prefill, arrangement } = loaded;
    const currency =
      arrangement?.currency ??
      mostCommon(loaded.shownEntries.map((entry) => entry.currency)) ??
      mostCommon(loaded.shownExpenses.map((expense) => expense.currency)) ??
      prefill.seller?.defaultCurrency ??
      prefill.clientCurrency;
    return {
      workspaceId,
      prefill: {
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
      },
    };
  });
  return Result.ok(prefills);
};

export const readMatterInvoicePrefill = async (
  tx: Transaction,
  { workspaceId, ...options }: MatterPrefillOptions,
) => {
  const result = await readMatterInvoicePrefills(tx, {
    ...options,
    workspaceIds: [workspaceId],
  });
  if (result.isErr()) {
    return result;
  }
  const first =
    result.value.at(0) ?? panic("Single-matter prefill has no result");
  return Result.ok(first.prefill);
};
