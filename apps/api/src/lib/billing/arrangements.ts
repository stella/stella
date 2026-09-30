import { panic } from "better-result";
import { eq, sql } from "drizzle-orm";

import {
  INVOICE_LINE_SOURCE,
  INVOICE_STATUS,
  TIME_ENTRY_ACTIVITY_GROUP,
} from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import {
  billingArrangements,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  type AuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

import {
  evaluateBillingCap,
  newBillingCapCrossings,
} from "./arrangements.logic";

type BillingArrangementConfiguration = Pick<
  typeof billingArrangements.$inferSelect,
  | "mode"
  | "currency"
  | "flatFeeAmount"
  | "capAmount"
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
  if (row.capAmount === null) {
    return { mode: row.mode, currency: row.currency, revision: row.revision };
  }
  return {
    mode: row.mode,
    currency: row.currency,
    capAmount: row.capAmount,
    alertThresholdBps:
      row.alertThresholdBps ?? panic("Capped arrangement has no threshold"),
    revision: row.revision,
  };
};

export const lockBillingArrangement = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
) => {
  // Same matter lock as timer/invoice guards; it also serializes first-row creation.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
  const rows = await tx
    .select()
    .from(billingArrangements)
    .where(eq(billingArrangements.workspaceId, workspaceId))
    .limit(1)
    .for("update");
  return rows.at(0);
};

type ReadBillingUsageOptions = {
  workspaceId: SafeId<"workspace">;
  currency: string;
  excludeInvoiceId?: SafeId<"invoice">;
};

export const readBillingUsage = async (
  tx: Transaction,
  { workspaceId, currency, excludeInvoiceId }: ReadBillingUsageOptions,
) => {
  // PostgreSQL numeric arithmetic prevents intermediate product/sum overflow;
  // half-up integer division matches prorateHourlyCents per entry, not after summing.
  const legacyCondition = sql`e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.invoice_attachment = 'charged' AND i.workspace_id = ${workspaceId} AND i.status <> ${INVOICE_STATUS.VOID} ${excludeInvoiceId ? sql`AND i.id <> ${excludeInvoiceId}` : sql``} AND NOT EXISTS (SELECT 1 FROM ${invoiceLines} l WHERE l.invoice_id = i.id AND l.time_entry_id = e.id AND l.source = ${INVOICE_LINE_SOURCE.TIME_ENTRY} AND l.released_at IS NULL)`;
  const legacyAmount = sql`COALESCE((SELECT SUM(FLOOR((e.rate_at_entry::numeric * e.billed_minutes + 30) / 60)) FROM ${timeEntries} e JOIN ${invoices} i ON i.id = e.invoice_id AND i.organization_id = e.organization_id WHERE ${legacyCondition} AND i.currency = ${currency}), 0)`;
  const legacyMismatch = sql`(SELECT COUNT(*) FROM ${timeEntries} e JOIN ${invoices} i ON i.id = e.invoice_id AND i.organization_id = e.organization_id WHERE ${legacyCondition} AND i.currency <> ${currency})`;
  const result = await tx
    .select({
      billedAmount: sql<string>`(${legacyAmount} + COALESCE((SELECT SUM(l.net_amount) FROM ${invoiceLines} l JOIN ${invoices} i ON i.id = l.invoice_id AND i.organization_id = l.organization_id WHERE l.workspace_id = ${workspaceId} AND i.workspace_id = ${workspaceId} AND l.source = ${INVOICE_LINE_SOURCE.TIME_ENTRY} AND l.released_at IS NULL AND i.status <> ${INVOICE_STATUS.VOID} AND i.currency = ${currency} ${excludeInvoiceId ? sql`AND i.id <> ${excludeInvoiceId}` : sql``}), 0))::text`,
      approvedAmount: sql<string>`COALESCE((SELECT SUM(FLOOR((e.rate_at_entry::numeric * e.billed_minutes + 30) / 60)) FROM ${timeEntries} e WHERE e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.status = 'approved' AND e.invoice_id IS NULL AND e.billable AND NOT e.no_charge AND e.currency = ${currency}), 0)::text`,
      mismatchCount: sql<string>`(${legacyMismatch} + (SELECT COUNT(*) FROM ${invoiceLines} l JOIN ${invoices} i ON i.id = l.invoice_id AND i.organization_id = l.organization_id WHERE l.workspace_id = ${workspaceId} AND i.workspace_id = ${workspaceId} AND l.source = ${INVOICE_LINE_SOURCE.TIME_ENTRY} AND l.released_at IS NULL AND i.status <> ${INVOICE_STATUS.VOID} AND i.currency <> ${currency} ${excludeInvoiceId ? sql`AND i.id <> ${excludeInvoiceId}` : sql``}) + (SELECT COUNT(*) FROM ${timeEntries} e WHERE e.workspace_id = ${workspaceId} AND e.activity_group = ${TIME_ENTRY_ACTIVITY_GROUP.CLIENT} AND e.status = 'approved' AND e.invoice_id IS NULL AND e.billable AND NOT e.no_charge AND e.currency <> ${currency}))::text`,
    })
    .from(sql`(SELECT 1) AS billing_usage`);
  const row = result.at(0) ?? panic("Billing aggregate returned no row");
  const billedAmount = BigInt(row.billedAmount);
  const approvedAmount = BigInt(row.approvedAmount);
  return {
    billedAmount,
    approvedAmount,
    totalAmount: billedAmount + approvedAmount,
    mismatchCount: BigInt(row.mismatchCount),
    currencyMismatch: row.mismatchCount !== "0",
  };
};

type RecordBillingCapCrossingsOptions = {
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
};

export const recordBillingCapCrossings = async (
  tx: Transaction,
  { workspaceId, recordAuditEvent }: RecordBillingCapCrossingsOptions,
): Promise<void> => {
  const arrangement = await lockBillingArrangement(tx, workspaceId);
  if (
    !arrangement ||
    arrangement.mode !== "hourly" ||
    arrangement.capAmount === null ||
    arrangement.alertThresholdBps === null
  ) {
    return;
  }
  const usage = await readBillingUsage(tx, {
    workspaceId,
    currency: arrangement.currency,
  });
  if (usage.currencyMismatch) {
    if (arrangement.currencyState === "mismatch") {
      return;
    }
    await tx
      .update(billingArrangements)
      .set({ currencyState: "mismatch", updatedAt: new Date() })
      .where(eq(billingArrangements.workspaceId, workspaceId));
    await recordAuditEvent(tx, [
      {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        workspaceId,
        metadata: {
          event: "billing_currency_mismatch",
          currency: arrangement.currency,
          mismatchCount: usage.mismatchCount.toString(),
          revision: arrangement.revision,
        },
      },
    ]);
    return;
  }
  const current = evaluateBillingCap({
    totalAmount: usage.totalAmount,
    capAmount: BigInt(arrangement.capAmount),
    alertThresholdBps: arrangement.alertThresholdBps,
  });
  const crossings = newBillingCapCrossings({ previous: arrangement, current });
  if (
    crossings.length === 0 &&
    arrangement.currencyState === "matched" &&
    arrangement.thresholdState === current.thresholdState &&
    arrangement.capState === current.capState
  ) {
    return;
  }
  const sequence = arrangement.crossingSequence + crossings.length;
  await tx
    .update(billingArrangements)
    .set({
      ...current,
      currencyState: "matched",
      crossingSequence: sequence,
      updatedAt: new Date(),
    })
    .where(eq(billingArrangements.workspaceId, workspaceId));
  if (crossings.length > 0) {
    await recordAuditEvent(
      tx,
      crossings.map((boundary, index) => ({
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        workspaceId,
        metadata: {
          event: "billing_cap_crossed",
          boundary,
          currency: arrangement.currency,
          usedAmount: usage.totalAmount.toString(),
          capAmount: String(arrangement.capAmount),
          revision: arrangement.revision,
          sequence: arrangement.crossingSequence + index + 1,
        },
      })),
    );
  }
};
