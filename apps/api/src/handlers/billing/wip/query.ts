import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { BILLING_STATUS, TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { contacts, expenses, timeEntries, workspaces } from "@/api/db/schema";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import type { SafeId } from "@/api/lib/branded-types";

import { WIP_LIMITS } from "./config";

const WIP_SOURCE = { TIME: "time", EXPENSE: "expense" } as const;
const DELETING_MATTER_STATUS = "deleting" as const;

type WipScope = {
  organizationId: SafeId<"organization">;
  matterId?: SafeId<"workspace">;
  clientId?: SafeId<"contact">;
  currency?: string;
  matterIds?: readonly SafeId<"workspace">[];
  clientIds?: readonly (SafeId<"contact"> | null)[];
};
const matterConditions = (scope: WipScope) =>
  and(
    eq(workspaces.organizationId, scope.organizationId),
    ne(workspaces.status, DELETING_MATTER_STATUS),
    scope.matterId ? eq(workspaces.id, scope.matterId) : undefined,
    scope.clientId ? eq(workspaces.clientId, scope.clientId) : undefined,
    scope.matterIds ? inArray(workspaces.id, [...scope.matterIds]) : undefined,
    scope.clientIds
      ? or(
          inArray(
            workspaces.clientId,
            scope.clientIds.filter((id) => id !== null),
          ),
          scope.clientIds.includes(null)
            ? isNull(workspaces.clientId)
            : undefined,
        )
      : undefined,
  );

const wipValues = (tx: Transaction, scope: WipScope) => {
  // Rates are the resolved historical snapshots recorded on each entry. Numeric
  // intermediates implement canonical per-entry half-up minor-unit arithmetic.
  const time = tx
    .select({
      matterId: workspaces.id,
      clientId: workspaces.clientId,
      currency: timeEntries.currency,
      amount:
        sql<string>`floor((${timeEntries.rateAtEntry}::numeric * ${timeEntries.billedMinutes} + 30) / 60)`.as(
          "amount",
        ),
      workedOn: sql<string>`${timeEntries.dateWorked}`.as("worked_on"),
      source: sql<string>`${WIP_SOURCE.TIME}`.as("source"),
      unpriced:
        sql<number>`case when ${timeEntries.currency} = ${UNPRICED_TIME_ENTRY_CURRENCY} then 1 else 0 end`.as(
          "unpriced",
        ),
    })
    .from(timeEntries)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, timeEntries.workspaceId),
        eq(workspaces.organizationId, timeEntries.organizationId),
      ),
    )
    .where(
      and(
        matterConditions(scope),
        eq(timeEntries.organizationId, scope.organizationId),
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        eq(timeEntries.status, BILLING_STATUS.APPROVED),
        isNull(timeEntries.invoiceId),
        eq(timeEntries.billable, true),
        eq(timeEntries.noCharge, false),
        scope.currency ? eq(timeEntries.currency, scope.currency) : undefined,
      ),
    );
  const expense = tx
    .select({
      matterId: workspaces.id,
      clientId: workspaces.clientId,
      currency: expenses.currency,
      amount:
        sql<string>`floor((${expenses.amount}::numeric * (100::numeric + ${expenses.markup}) + 50) / 100)`.as(
          "amount",
        ),
      workedOn: sql<string>`${expenses.dateIncurred}`.as("worked_on"),
      source: sql<string>`${WIP_SOURCE.EXPENSE}`.as("source"),
      unpriced: sql<number>`0`.as("unpriced"),
    })
    .from(expenses)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, expenses.workspaceId),
        eq(workspaces.organizationId, expenses.organizationId),
      ),
    )
    .where(
      and(
        matterConditions(scope),
        eq(expenses.organizationId, scope.organizationId),
        isNull(expenses.invoiceId),
        eq(expenses.billable, true),
        inArray(expenses.status, [
          BILLING_STATUS.DRAFT,
          BILLING_STATUS.APPROVED,
        ]),
        scope.currency ? eq(expenses.currency, scope.currency) : undefined,
      ),
    );
  return tx.$with("wip_values").as(unionAll(time, expense));
};

const aggregates = (values: ReturnType<typeof wipValues>, asOf: string) => {
  const age = sql`greatest(0, ${asOf}::date - ${values.workedOn}::date)`;
  return {
    currency: values.currency,
    timeAmount: sql<string>`coalesce(sum(${values.amount}) filter (where ${values.source} = ${WIP_SOURCE.TIME}), 0)::text`,
    expenseAmount: sql<string>`coalesce(sum(${values.amount}) filter (where ${values.source} = ${WIP_SOURCE.EXPENSE}), 0)::text`,
    totalAmount: sql<string>`coalesce(sum(${values.amount}), 0)::text`,
    days0To30: sql<string>`coalesce(sum(${values.amount}) filter (where ${age} <= 30), 0)::text`,
    days31To60: sql<string>`coalesce(sum(${values.amount}) filter (where ${age} between 31 and 60), 0)::text`,
    days61To90: sql<string>`coalesce(sum(${values.amount}) filter (where ${age} between 61 and 90), 0)::text`,
    daysOver90: sql<string>`coalesce(sum(${values.amount}) filter (where ${age} > 90), 0)::text`,
    unpricedTimeEntryCount: sql<string>`coalesce(sum(${values.unpriced}), 0)::text`,
  };
};

type WipCurrencyQueryOptions = WipScope & { asOf: string };
export const buildWipCurrencyQuery = (
  tx: Transaction,
  options: WipCurrencyQueryOptions,
) => {
  const values = wipValues(tx, options);
  return tx
    .with(values)
    .select(aggregates(values, options.asOf))
    .from(values)
    .groupBy(values.currency)
    .orderBy(asc(values.currency))
    .limit(WIP_LIMITS.currenciesMax + 1);
};
type WipMatterQueryOptions = WipScope & {
  after?: SafeId<"workspace">;
  limit: number;
};
const buildWipMatterQuery = (
  tx: Transaction,
  options: WipMatterQueryOptions,
) => {
  const values = wipValues(tx, options);
  return tx
    .with(values)
    .select({
      matterId: workspaces.id,
      matterName: workspaces.name,
      matterReference: workspaces.reference,
      clientId: workspaces.clientId,
      clientName: contacts.displayName,
    })
    .from(workspaces)
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, workspaces.clientId),
        eq(contacts.organizationId, workspaces.organizationId),
      ),
    )
    .where(
      and(
        matterConditions(options),
        options.after ? gt(workspaces.id, options.after) : undefined,
        exists(
          tx
            .select({ id: values.matterId })
            .from(values)
            .where(eq(values.matterId, workspaces.id)),
        ),
      ),
    )
    .orderBy(asc(workspaces.id))
    .limit(options.limit + 1);
};

type WipClientQueryOptions = WipScope & { after?: string; limit: number };
const buildWipClientQuery = (
  tx: Transaction,
  options: WipClientQueryOptions,
) => {
  const values = wipValues(tx, options);
  const key = sql<string>`coalesce(${values.clientId}::text, '')`;
  return tx
    .with(values)
    .select({
      clientId: values.clientId,
      clientName: contacts.displayName,
      key: key.as("client_key"),
    })
    .from(values)
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, values.clientId),
        eq(contacts.organizationId, options.organizationId),
      ),
    )
    .where(options.after === undefined ? undefined : gt(key, options.after))
    .groupBy(values.clientId, contacts.displayName)
    .orderBy(asc(key))
    .limit(options.limit + 1);
};

type WipMatterPageOptions = WipMatterQueryOptions & { asOf: string };
export const buildWipMatterPageQuery = (
  tx: Transaction,
  options: WipMatterPageOptions,
) => {
  const values = wipValues(tx, options);
  const page = buildWipMatterQuery(tx, options).as("wip_matter_page");
  return tx
    .with(values)
    .select({
      matterId: page.matterId,
      matterName: page.matterName,
      matterReference: page.matterReference,
      clientId: page.clientId,
      clientName: page.clientName,
      ...aggregates(values, options.asOf),
    })
    .from(page)
    .innerJoin(values, eq(values.matterId, page.matterId))
    .groupBy(
      page.matterId,
      page.matterName,
      page.matterReference,
      page.clientId,
      page.clientName,
      values.currency,
    )
    .orderBy(asc(page.matterId), asc(values.currency))
    .limit((options.limit + 1) * WIP_LIMITS.currenciesMax);
};

type WipClientPageOptions = WipClientQueryOptions & { asOf: string };
export const buildWipClientPageQuery = (
  tx: Transaction,
  options: WipClientPageOptions,
) => {
  const values = wipValues(tx, options);
  const page = buildWipClientQuery(tx, options).as("wip_client_page");
  return tx
    .with(values)
    .select({
      clientId: page.clientId,
      clientName: page.clientName,
      key: page.key,
      ...aggregates(values, options.asOf),
    })
    .from(page)
    .innerJoin(
      values,
      sql`${values.clientId} IS NOT DISTINCT FROM ${page.clientId}`,
    )
    .groupBy(page.clientId, page.clientName, page.key, values.currency)
    .orderBy(asc(page.key), asc(values.currency))
    .limit((options.limit + 1) * WIP_LIMITS.currenciesMax);
};
