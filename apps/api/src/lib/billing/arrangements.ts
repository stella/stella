import { panic } from "better-result";
import { getTableName, sql } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { billingArrangements, timeEntries } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditEvent,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { lockBillingCapArrangements } from "@/api/lib/db/aggregate-lock";
import { LIMITS } from "@/api/lib/limits";

import {
  evaluateBillingArrangementCaps,
  newBillingCapCrossings,
} from "./arrangements.logic";

type BillingArrangementConfiguration = Pick<
  typeof billingArrangements.$inferSelect,
  | "mode"
  | "currency"
  | "flatFeeAmount"
  | "capAmount"
  | "capMinutes"
  | "alertThresholdBps"
  | "revision"
>;

export const billingArrangementResponse = (
  row: BillingArrangementConfiguration,
) => {
  if (row.mode === "flat_fee") {
    return {
      mode: row.mode,
      currency: row.currency,
      flatFeeAmount: row.flatFeeAmount ?? panic("Flat arrangement has no fee"),
      revision: row.revision,
    };
  }
  if (row.capAmount === null && row.capMinutes === null) {
    return { mode: row.mode, currency: row.currency, revision: row.revision };
  }
  const alertThresholdBps =
    row.alertThresholdBps ?? panic("Capped arrangement has no threshold");
  if (row.capMinutes !== null) {
    return {
      mode: row.mode,
      currency: row.currency,
      capMinutes: row.capMinutes,
      ...(row.capAmount === null ? {} : { capAmount: row.capAmount }),
      alertThresholdBps,
      revision: row.revision,
    };
  }
  return {
    mode: row.mode,
    currency: row.currency,
    capAmount:
      row.capAmount ?? panic("Capped arrangement has no amount or minute cap"),
    alertThresholdBps,
    revision: row.revision,
  };
};

type ReadBillingUsageOptions = {
  workspaceId: SafeId<"workspace">;
  currency: string;
  excludeInvoiceId?: SafeId<"invoice">;
};

type BillingUsageProjectionOptions = {
  workspaceId: SafeId<"workspace"> | typeof billingArrangements.workspaceId;
  currency: string | typeof billingArrangements.currency;
  excludeInvoiceId?: SafeId<"invoice">;
};

const billingUsageProjection = ({
  workspaceId: workspace,
  currency: currencyValue,
  excludeInvoiceId,
}: BillingUsageProjectionOptions) => {
  // Drizzle unqualifies direct Column chunks in single-table SELECT projections.
  // Schema-derived identifiers preserve outer references inside correlated subqueries.
  const workspaceId =
    typeof workspace === "string"
      ? workspace
      : sql`${sql.identifier(getTableName(billingArrangements))}.${sql.identifier(workspace.name)}`;
  const currency =
    typeof currencyValue === "string"
      ? currencyValue
      : sql`${sql.identifier(getTableName(billingArrangements))}.${sql.identifier(currencyValue.name)}`;
  // Complete-invoice RLS hides shared invoices from partial members. The
  // narrowly authorized aggregate still counts every charge against this matter's cap.
  const reserved = sql`public.stella_matter_reserved_charges(${workspaceId},${currency},${excludeInvoiceId ?? null})`;
  return {
    billedAmount: sql<string>`(SELECT amount::text FROM ${reserved})`,
    billedMinutes: sql<string>`public.stella_matter_reserved_minutes(${workspaceId},${excludeInvoiceId ?? null})::text`,
    approvedMinutes: sql<string>`COALESCE((SELECT SUM(e.billed_minutes) FROM ${timeEntries} e WHERE e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.status = 'approved' AND e.invoice_id IS NULL AND e.billable AND NOT e.no_charge), 0)::text`,
    approvedAmount: sql<string>`COALESCE((SELECT SUM(FLOOR((e.rate_at_entry::numeric * e.billed_minutes + 30) / 60)) FROM ${timeEntries} e WHERE e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.status = 'approved' AND e.invoice_id IS NULL AND e.billable AND NOT e.no_charge AND e.currency = ${currency}), 0)::text`,
    // Reserved invoice charges and approved unbilled work are counted apart:
    // an invoice is checked against what is reserved, the cap status against both.
    billedMismatchCount: sql<string>`(SELECT mismatches::text FROM ${reserved})`,
    approvedMismatchCount: sql<string>`(SELECT COUNT(*) FROM ${timeEntries} e WHERE e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.status = 'approved' AND e.invoice_id IS NULL AND e.billable AND NOT e.no_charge AND e.currency <> ${currency})::text`,
  };
};

export const readBillingUsage = async (
  tx: Transaction,
  options: ReadBillingUsageOptions,
) => {
  const result = await tx
    .select(billingUsageProjection(options))
    .from(sql`(SELECT 1) AS billing_usage`);
  const row = result.at(0) ?? panic("Billing aggregate returned no row");
  const billedAmount = BigInt(row.billedAmount);
  const approvedAmount = BigInt(row.approvedAmount);
  const billedMismatchCount = BigInt(row.billedMismatchCount);
  const mismatchCount = billedMismatchCount + BigInt(row.approvedMismatchCount);
  return {
    billedAmount,
    approvedAmount,
    billedMinutes: BigInt(row.billedMinutes),
    approvedMinutes: BigInt(row.approvedMinutes),
    totalMinutes: BigInt(row.billedMinutes) + BigInt(row.approvedMinutes),
    totalAmount: billedAmount + approvedAmount,
    mismatchCount,
    currencyMismatch: mismatchCount !== 0n,
    billedCurrencyMismatch: billedMismatchCount !== 0n,
  };
};

type RecordBillingCapCrossingsForMattersOptions = {
  workspaceIds: readonly SafeId<"workspace">[];
  recordAuditEvent: AuditRecorder;
};

export const recordBillingCapCrossingsForMatters = async (
  tx: Transaction,
  {
    workspaceIds,
    recordAuditEvent,
  }: RecordBillingCapCrossingsForMattersOptions,
): Promise<void> => {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) {
    return;
  }
  if (ids.length > LIMITS.timeEntriesApprovalBatchMax) {
    panic("Cap reconciliation exceeds the approval batch limit");
  }
  const rows = await lockBillingCapArrangements(tx, {
    workspaceIds: ids,
    usageProjection: billingUsageProjection({
      workspaceId: billingArrangements.workspaceId,
      currency: billingArrangements.currency,
    }),
  });
  const updates: (typeof billingArrangements.$inferInsert)[] = [];
  const events: AuditEvent[] = [];
  const now = new Date();
  for (const {
    arrangement,
    billedAmount,
    approvedAmount,
    billedMinutes,
    approvedMinutes,
    billedMismatchCount,
    approvedMismatchCount,
  } of rows) {
    const { workspaceId } = arrangement;
    const mismatchCount = (
      BigInt(billedMismatchCount) + BigInt(approvedMismatchCount)
    ).toString();
    const currencyState = mismatchCount === "0" ? "matched" : "mismatch";
    if (
      currencyState === "mismatch" &&
      arrangement.currencyState !== "mismatch"
    ) {
      events.push({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        workspaceId,
        metadata: {
          event: "billing_currency_mismatch",
          currency: arrangement.currency,
          mismatchCount,
          revision: arrangement.revision,
        },
      });
    }
    const totalAmount = BigInt(billedAmount) + BigInt(approvedAmount);
    const capAmount = arrangement.capAmount;
    const totalMinutes = BigInt(billedMinutes) + BigInt(approvedMinutes);
    const alertThresholdBps =
      arrangement.alertThresholdBps ??
      panic("Locked capped arrangement has no threshold");
    const { amount, minutes } = evaluateBillingArrangementCaps({
      totalAmount,
      totalMinutes,
      capAmount,
      capMinutes: arrangement.capMinutes,
      alertThresholdBps,
    });
    // Currency prevents amount comparisons; elapsed billable minutes remain exact.
    const current =
      currencyState === "mismatch"
        ? {
            thresholdState: arrangement.thresholdState,
            capState: arrangement.capState,
          }
        : amount;
    const crossings = [
      ...newBillingCapCrossings({ previous: arrangement, current }).map(
        (boundary) => ({ boundary, unit: "amount" as const }),
      ),
      ...newBillingCapCrossings({
        previous: {
          thresholdState: arrangement.minuteThresholdState ?? "below",
          capState: arrangement.minuteCapState ?? "below",
        },
        current: minutes,
      }).map((boundary) => ({ boundary, unit: "minutes" as const })),
    ];
    if (
      crossings.length === 0 &&
      arrangement.currencyState === currencyState &&
      arrangement.thresholdState === current.thresholdState &&
      arrangement.capState === current.capState &&
      arrangement.minuteThresholdState === minutes.thresholdState &&
      arrangement.minuteCapState === minutes.capState
    ) {
      continue;
    }
    updates.push({
      ...arrangement,
      ...current,
      minuteThresholdState: minutes.thresholdState,
      minuteCapState: minutes.capState,
      currencyState,
      crossingSequence: arrangement.crossingSequence + crossings.length,
      updatedAt: now,
    });
    for (const [index, { boundary, unit }] of crossings.entries()) {
      events.push({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        workspaceId,
        metadata: {
          event: "billing_cap_crossed",
          boundary,
          unit,
          usedMinutes: totalMinutes.toString(),
          capMinutes: arrangement.capMinutes,
          currency: arrangement.currency,
          usedAmount: totalAmount.toString(),
          capAmount: capAmount?.toString() ?? null,
          revision: arrangement.revision,
          sequence: arrangement.crossingSequence + index + 1,
        },
      });
    }
  }
  if (updates.length === 0) {
    return;
  }
  // All targets were locked above; conflict writes change only derived crossing state.
  await tx
    .insert(billingArrangements)
    .values(updates)
    .onConflictDoUpdate({
      target: billingArrangements.workspaceId,
      set: {
        thresholdState: sql`excluded.threshold_state`,
        capState: sql`excluded.cap_state`,
        minuteThresholdState: sql`excluded.minute_threshold_state`,
        minuteCapState: sql`excluded.minute_cap_state`,
        currencyState: sql`excluded.currency_state`,
        crossingSequence: sql`excluded.crossing_sequence`,
        updatedAt: now,
      },
    });
  if (events.length > 0) {
    await recordAuditEvent(tx, events);
  }
};

type RecordBillingCapCrossingsOptions = {
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
};

export const recordBillingCapCrossings = async (
  tx: Transaction,
  { workspaceId, recordAuditEvent }: RecordBillingCapCrossingsOptions,
): Promise<void> => {
  await recordBillingCapCrossingsForMatters(tx, {
    workspaceIds: [workspaceId],
    recordAuditEvent,
  });
};
