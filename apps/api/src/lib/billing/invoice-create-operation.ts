import { panic, Result } from "better-result";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { parsePlainDate } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_BILLING_PURPOSE,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { INVOICE_ENTRIES_MODIFIED_MESSAGE } from "@/api/lib/billing/invoice-concurrent-modification";
import type { createInvoiceBodySchema } from "@/api/lib/billing/invoice-create-contract";
import {
  type tInvoiceDocumentType,
  validateInvoiceDocument,
} from "@/api/lib/billing/invoice-document-type";
import {
  ATTACHED_ENTRY_LINE_VAT,
  attachedEntryLineDrafts,
  type AttachedEntryLineDraftsOptions,
  insertInvoiceLines,
  type LineVat,
  manualLineDraft,
  recalculateInvoiceTotals,
} from "@/api/lib/billing/invoice-lines";
import { resolveInvoicePrefill } from "@/api/lib/billing/invoice-prefill";
import { latestDate } from "@/api/lib/billing/invoice-prefill.logic";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { lockBillingArrangement } from "@/api/lib/db/aggregate-lock";
import type { AcquiredInvoiceMatterLocks } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  claimInvoiceExpenses,
  claimInvoiceTimeEntries,
} from "@/api/lib/db/transitions";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { CentsAmount } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";

type InvoiceDocumentType = v.InferOutput<typeof tInvoiceDocumentType>;

type CreateInvoiceResult = {
  id: SafeId<"invoice">;
  invoiceNumber: string | null;
  totalAmount: CentsAmount;
  entryCount: number;
  expenseCount: number;
};
type CreateInvoiceBody = v.InferOutput<typeof createInvoiceBodySchema>;
// The request with its optional lists resolved once, so no step re-defaults them.
type CreateInvoiceInput = Omit<
  CreateInvoiceBody,
  "expenseIds" | "entryAdjustments"
> & {
  expenseIds: NonNullable<CreateInvoiceBody["expenseIds"]>;
  entryAdjustments: NonNullable<CreateInvoiceBody["entryAdjustments"]>;
};
export const createInvoiceInput = ({
  expenseIds = [],
  entryAdjustments = [],
  ...rest
}: CreateInvoiceBody): CreateInvoiceInput => ({
  ...rest,
  expenseIds,
  entryAdjustments,
});
type InvoiceCreationEntryOptions = {
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
  flatFee: CentsAmount | null;
};
const validateCreationEntries = async (
  tx: Transaction,
  { workspaceId, body, flatFee }: InvoiceCreationEntryOptions,
) => {
  const selected =
    body.timeEntryIds.length === 0
      ? []
      : await tx
          .select({
            id: timeEntries.id,
            status: timeEntries.status,
            billable: timeEntries.billable,
            currency: timeEntries.currency,
            invoiceId: timeEntries.invoiceId,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
              inArray(timeEntries.id, body.timeEntryIds),
            ),
          );
  if (selected.length !== body.timeEntryIds.length) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Some time entries were not found",
      }),
    );
  }
  if (
    selected.some(
      (entry) =>
        entry.status !== BILLING_STATUS.APPROVED ||
        entry.invoiceId !== null ||
        (flatFee === null && !entry.billable),
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "All entries must be approved, not already on an invoice, and billable for hourly billing",
      }),
    );
  }
  if (
    flatFee === null &&
    selected.some((entry) => entry.currency !== body.currency)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "All time entries must match the invoice currency",
      }),
    );
  }
  const adjusted = new Set(
    body.entryAdjustments.map((entry) => entry.timeEntryId),
  );
  const selectedIds = new Set<string>(body.timeEntryIds);
  if (
    adjusted.size !== body.entryAdjustments.length ||
    [...adjusted].some((id) => !selectedIds.has(id))
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_entry_adjustments",
        message:
          "Each entry adjustment must name a distinct entry from timeEntryIds",
        hint: "Adjust only entries listed in timeEntryIds, once each.",
      }),
    );
  }
  return validateCreationExpenses(tx, { workspaceId, body });
};

type CreationExpenseOptions = {
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
};
const validateCreationExpenses = async (
  tx: Transaction,
  { workspaceId, body }: CreationExpenseOptions,
) => {
  const expenseIds = body.expenseIds;
  if (expenseIds.length === 0) {
    return Result.ok(undefined);
  }
  const rows = await tx
    .select({
      status: expenses.status,
      billable: expenses.billable,
      invoiceId: expenses.invoiceId,
      currency: expenses.currency,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.workspaceId, workspaceId),
        inArray(expenses.id, expenseIds),
      ),
    );
  if (rows.length !== new Set(expenseIds).size) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Some expenses were not found",
      }),
    );
  }
  if (
    rows.some(
      (expense) =>
        expense.status !== BILLING_STATUS.APPROVED ||
        !expense.billable ||
        expense.invoiceId !== null,
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "All expenses must be approved, billable, and not already on an invoice",
      }),
    );
  }
  if (rows.some((expense) => expense.currency !== body.currency)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "All expenses must match the invoice currency",
      }),
    );
  }
  return Result.ok(undefined);
};

const createInvoiceLineDrafts = (
  entries: AttachedEntryLineDraftsOptions["timeEntryRows"],
  attachedExpenses: AttachedEntryLineDraftsOptions["expenseRows"],
  flatFee: CentsAmount | null,
  vat: LineVat,
) => {
  if (flatFee === null) {
    return Result.ok(
      attachedEntryLineDrafts({
        timeEntryRows: entries,
        expenseRows: attachedExpenses,
        vat,
      }),
    );
  }
  return manualLineDraft({
    description: "Flat fee",
    quantity: "1",
    unit: null,
    unitPrice: flatFee,
    ...vat,
  }).map((fee) => [
    { ...fee, billingPurpose: INVOICE_BILLING_PURPOSE.FLAT_FEE } as const,
  ]);
};

type EntryAdjustmentOptions = {
  actorUserId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  adjustments: CreateInvoiceInput["entryAdjustments"];
  memberRole: AuthorizedMemberRole;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
/**
 * Writes billed minutes and no-charge onto approved entries before they are
 * claimed, so the invoice line and the entry agree. Writing down or waiving
 * time is an approval decision, so it needs the approve permission.
 */
const applyEntryAdjustments = async (
  tx: Transaction,
  {
    actorUserId,
    workspaceId,
    adjustments,
    memberRole,
    now,
    recordAuditEvent,
  }: EntryAdjustmentOptions,
): Promise<Result<void, HandlerError>> => {
  if (adjustments.length === 0) {
    return Result.ok(undefined);
  }
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: {
      type: "entries",
      ids: adjustments.map((entry) => entry.timeEntryId),
    },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  if (!canApproveTimeEntries(memberRole)) {
    return Result.err(
      new HandlerError({
        status: 403,
        code: "entry_adjustment_forbidden",
        message:
          "Changing billed time needs permission to approve time entries",
        hint: "Omit entryAdjustments, or ask someone who approves time to create the invoice.",
      }),
    );
  }
  const before = await tx
    .select({
      id: timeEntries.id,
      billedMinutes: timeEntries.billedMinutes,
      noCharge: timeEntries.noCharge,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(
          timeEntries.id,
          adjustments.map((entry) => entry.timeEntryId),
        ),
        eq(timeEntries.status, BILLING_STATUS.APPROVED),
        isNull(timeEntries.invoiceId),
      ),
    );
  const previous = new Map(before.map((row) => [row.id, row]));
  const changed = adjustments.filter((entry) => {
    const row = previous.get(entry.timeEntryId);
    return (
      row !== undefined &&
      (row.billedMinutes !== entry.billedMinutes ||
        row.noCharge !== entry.noCharge)
    );
  });
  for (const entry of changed) {
    // db-await-in-loop: one keyed update per changed entry, bounded by the 500-entry body limit
    await tx
      .update(timeEntries)
      .set({
        billedMinutes: entry.billedMinutes,
        noCharge: entry.noCharge,
        updatedAt: now,
      })
      .where(
        and(
          eq(timeEntries.workspaceId, workspaceId),
          eq(timeEntries.id, entry.timeEntryId),
        ),
      );
  }
  if (changed.length > 0) {
    await recordAuditEvent(
      tx,
      changed.map((entry) => {
        const row = previous.get(entry.timeEntryId);
        return {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.timeEntryId,
          changes: {
            billedMinutes: {
              old: row?.billedMinutes ?? null,
              new: entry.billedMinutes,
            },
            noCharge: { old: row?.noCharge ?? null, new: entry.noCharge },
          },
        };
      }),
    );
  }
  return Result.ok(undefined);
};

type SupplyDateOptions = {
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
};
/** The last day of included work, which is when the supply took place. */
const lastWorkDate = async (
  tx: Transaction,
  { workspaceId, body }: SupplyDateOptions,
) => {
  const [entryDates, expenseDates] = await Promise.all([
    body.timeEntryIds.length === 0
      ? []
      : tx
          .select({ date: timeEntries.dateWorked })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, body.timeEntryIds),
            ),
          ),
    body.expenseIds.length === 0
      ? []
      : tx
          .select({ date: expenses.dateIncurred })
          .from(expenses)
          .where(
            and(
              eq(expenses.workspaceId, workspaceId),
              inArray(expenses.id, body.expenseIds),
            ),
          ),
  ]);
  return latestDate(
    [...entryDates, ...expenseDates].map((row) => row.date),
    body.invoiceDate,
  );
};

/** The issue date plus the payment term, as an ISO date. */
const dueDateAfter = (invoiceDate: string, days: number) =>
  parsePlainDate(invoiceDate)?.add({ days }).toString() ?? null;

type CreationDefaultsOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
  documentType: InvoiceDocumentType;
  flatFee: CentsAmount | null;
};
/**
 * The prefill a new draft starts from and the dates it implies. Explicit
 * dates in the request win; a credit note is not prefilled.
 */
const resolveCreationDefaults = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    body,
    documentType,
    flatFee,
  }: CreationDefaultsOptions,
) => {
  if (flatFee !== null && body.expenseIds.length > 0) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "flat_fee_expenses",
        message: "A flat-fee invoice bills its agreed fee as its only line",
        hint: "Omit expenseIds for this matter, or bill the expenses on a separate invoice after changing the arrangement.",
      }),
    );
  }
  const workDate =
    documentType === "credit_note"
      ? body.invoiceDate
      : await lastWorkDate(tx, { workspaceId, body });
  const resolvedPrefill = await resolveInvoicePrefill(tx, {
    organizationId,
    workspaceId,
    sellerProfileId: body.sellerProfileId,
    supplyDate: body.taxableSupplyDate ?? workDate,
  });
  const prefill = documentType === "credit_note" ? null : resolvedPrefill;
  if (prefill?.sellerSource === "not_found") {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "seller_profile_not_found",
        message: "Seller profile not found or archived",
        hint: "List seller profiles with seller-profiles.list and pass an active sellerProfileId, or omit it to use the default.",
      }),
    );
  }
  const taxableSupplyDate =
    body.taxableSupplyDate === undefined && prefill !== null
      ? workDate
      : (body.taxableSupplyDate ?? null);
  const dueDate =
    body.dueDate === undefined && prefill !== null
      ? dueDateAfter(body.invoiceDate, prefill.dueDays)
      : (body.dueDate ?? null);
  return Result.ok({
    prefill,
    taxableSupplyDate,
    dueDate,
    language: body.language ?? resolvedPrefill.language,
  });
};

type CreateDraftInvoiceOptions = {
  actorUserId: SafeId<"user">;
  clientId?: SafeId<"contact">;
  memberRole: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
type CreationMatterLocks =
  { type: "single_matter" } | AcquiredInvoiceMatterLocks;
type CheckCreationOptions = {
  organizationId: SafeId<"organization">;
  matterLocks: CreationMatterLocks;
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
};
/** Everything that can refuse a create before anything is written. */
const checkCreation = async (
  tx: Transaction,
  { organizationId, workspaceId, body, matterLocks }: CheckCreationOptions,
) => {
  const arrangement = await lockBillingArrangement(tx, workspaceId);
  const flatFee =
    (body.documentType ?? "invoice") === "invoice" &&
    arrangement?.mode === "flat_fee"
      ? arrangement.flatFeeAmount
      : null;
  if (flatFee !== null && arrangement?.currency !== body.currency) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "billing_currency_mismatch",
        message: "A flat-fee invoice must use the arrangement currency",
        hint: "Read rates.arrangement.get for this matter, then retry invoices.create with the returned currency.",
      }),
    );
  }
  const entries = await validateCreationEntries(tx, {
    workspaceId,
    body,
    flatFee,
  });
  if (entries.isErr()) {
    return Result.err(entries.error);
  }
  const documentType = body.documentType ?? "invoice";
  const originalInvoiceId = body.originalInvoiceId ?? null;
  if (
    documentType === "credit_note" &&
    (body.timeEntryIds.length > 0 || body.expenseIds.length > 0)
  ) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Credit notes cannot bill time entries or expenses",
      }),
    );
  }
  const valid = await validateInvoiceDocument(tx, {
    workspaceId,
    documentType,
    originalInvoiceId,
    currency: body.currency,
  });
  if (valid.isErr()) {
    return Result.err(valid.error);
  }
  const originalScope =
    originalInvoiceId === null
      ? null
      : await tx.query.invoices.findFirst({
          where: {
            id: { eq: originalInvoiceId },
            organizationId: { eq: organizationId },
          },
          columns: { workspaceId: true, clientId: true },
        });
  const quotaMatters = new Set<SafeId<"workspace">>();
  switch (matterLocks.type) {
    case "single_matter":
      quotaMatters.add(workspaceId);
      break;
    case "acquired": {
      if (
        originalInvoiceId !== matterLocks.invoiceId ||
        documentType !== "credit_note"
      ) {
        return panic(
          "Credit creation locks do not belong to the original invoice",
        );
      }
      if (originalScope === null || originalScope === undefined) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Original invoice not found in this matter",
          }),
        );
      }
      const participantRead = await readBounded(
        tx
          .selectDistinct({ workspaceId: invoiceLines.workspaceId })
          .from(invoiceLines)
          .where(
            and(
              eq(invoiceLines.organizationId, organizationId),
              eq(invoiceLines.invoiceId, originalInvoiceId),
            ),
          ),
        LIMITS.invoiceLinesPerInvoice,
      );
      if (participantRead.type === "overflow") {
        return Result.err(
          new HandlerError({
            status: 409,
            code: "invoice_participation_changed",
            message: "Invoice matters changed; reload and try again",
          }),
        );
      }
      const participants = participantRead.rows;
      if (originalScope.workspaceId !== null) {
        quotaMatters.add(originalScope.workspaceId);
      }
      for (const participant of participants) {
        quotaMatters.add(participant.workspaceId);
      }
      // validateInvoiceDocument holds the original row. Refuse a snapshot
      // expansion without acquiring any new matter lock after it.
      if ([...quotaMatters].some((id) => !matterLocks.workspaceIds.has(id))) {
        return Result.err(
          new HandlerError({
            status: 409,
            code: "invoice_participation_changed",
            message: "Invoice matters changed; reload and try again",
          }),
        );
      }
      break;
    }
    default:
      matterLocks satisfies never;
      return panic("Unknown invoice creation lock scope");
  }
  if (quotaMatters.size > 0) {
    const counts = await tx
      .select({
        count: sql<string>`max(public.stella_matter_invoice_count(quota.matter_id))::text`,
      })
      .from(
        sql`unnest(ARRAY[${sql.join(
          [...quotaMatters].map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) AS quota(matter_id)`,
      );
    const totalInvoices = parseIntegerToken(
      counts.at(0)?.count ?? panic("Invoice quota aggregate returned no row"),
      { sign: "unsigned" },
    ).unwrap("Invoice quota aggregate must return a safe non-negative integer");
    if (totalInvoices >= LIMITS.invoicesPerWorkspace) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            matterLocks.type === "acquired"
              ? "Invoice limit reached for a participating matter"
              : "Invoice limit reached for this workspace",
        }),
      );
    }
  }
  return Result.ok({ flatFee, documentType, originalInvoiceId, originalScope });
};

type BillCreatedDraftOptions = {
  actorUserId: SafeId<"user">;
  auditAction?: typeof AUDIT_ACTION.CREATE | typeof AUDIT_ACTION.UPDATE;
  created: { id: SafeId<"invoice">; invoiceNumber: string | null };
  body: CreateInvoiceInput;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  flatFee: CentsAmount | null;
  vat: LineVat;
  documentType: InvoiceDocumentType;
  originalInvoiceId: SafeId<"invoice"> | null;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
/**
 * Claims the requested entries and expenses for a just-inserted draft, writes
 * its lines and totals, and records the creation. A claim that finds fewer
 * rows than requested is a concurrent change; the caller rolls back.
 */
export const billCreatedDraft = async (
  tx: Transaction,
  {
    actorUserId,
    created,
    auditAction = AUDIT_ACTION.CREATE,
    body,
    workspaceId,
    organizationId,
    flatFee,
    vat,
    documentType,
    originalInvoiceId,
    now,
    recordAuditEvent,
  }: BillCreatedDraftOptions,
): Promise<Result<CreateInvoiceResult, HandlerError>> => {
  // Re-checked under the claim: the caller's check ran before the matter lock.
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "entries", ids: body.timeEntryIds },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  const updated = await claimInvoiceTimeEntries({
    tx,
    workspaceId,
    invoiceId: created.id,
    timeEntryIds: body.timeEntryIds,
    currency: body.currency,
    invoiceAttachment:
      flatFee === null
        ? INVOICE_ATTACHMENT.CHARGED
        : INVOICE_ATTACHMENT.COVERED,
    now,
    recordAuditEvent,
  });

  const expenseIds = body.expenseIds;
  const attachedExpenses =
    expenseIds.length === 0
      ? []
      : await claimInvoiceExpenses(tx, {
          workspaceId,
          invoiceId: created.id,
          expenseIds,
          currency: body.currency,
          now,
        });
  const linkedCount = updated.length;
  if (
    linkedCount !== body.timeEntryIds.length ||
    attachedExpenses.length !== new Set(body.expenseIds).size
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: INVOICE_ENTRIES_MODIFIED_MESSAGE,
      }),
    );
  }

  // The lines and totals written below record their own invoice events.
  await recordAuditEvent(tx, [
    {
      action: auditAction,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: created.id,
      metadata: { documentType, originalInvoiceId },
      changes: {
        created: {
          old: null,
          new: {
            invoiceNumber: created.invoiceNumber,
            invoiceDate: body.invoiceDate,
            currency: body.currency,
            entryCount: linkedCount,
            expenseCount: attachedExpenses.length,
            status: INVOICE_STATUS.DRAFT,
          },
        },
      },
    },
    ...attachedExpenses.map((expense) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: expense.id,
      changes: {
        status: { old: BILLING_STATUS.APPROVED, new: BILLING_STATUS.BILLED },
        invoiceId: { old: null, new: created.id },
      },
    })),
  ]);

  const scope = { invoiceId: created.id, workspaceId };
  const drafted = createInvoiceLineDrafts(
    updated,
    attachedExpenses,
    flatFee,
    vat,
  );
  if (drafted.isErr()) {
    return Result.err(drafted.error);
  }
  const lines = drafted.value;
  const inserted = await insertInvoiceLines(
    tx,
    { ...scope, organizationId },
    lines,
    { recordAuditEvent },
  );
  if (inserted.isErr()) {
    return Result.err(inserted.error);
  }
  const totals = await recalculateInvoiceTotals(
    tx,
    scope,
    now,
    recordAuditEvent,
  );
  if (totals.isErr()) {
    return Result.err(totals.error);
  }
  const totalAmount = totals.value.grossAmountMinor;
  if (
    body.expectedTotalAmount !== undefined &&
    totalAmount !== body.expectedTotalAmount
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "invoice_total_changed",
        message: "The invoice total differs from the reviewed amount",
        hint: "Read invoices.prefill again; the VAT rate for the supply date or the selected items may differ from what was reviewed.",
      }),
    );
  }

  return Result.ok({
    id: created.id,
    invoiceNumber: created.invoiceNumber,
    totalAmount,
    entryCount: linkedCount,
    expenseCount: attachedExpenses.length,
  });
};

export const createDraftInvoice = async (
  tx: Transaction,
  {
    actorUserId,
    memberRole,
    organizationId,
    workspaceId,
    clientId,
    body,
    now,
    recordAuditEvent,
  }: CreateDraftInvoiceOptions,
): Promise<Result<CreateInvoiceResult, HandlerError>> => {
  let matterLocks: CreationMatterLocks = { type: "single_matter" };
  if (
    body.documentType === "credit_note" &&
    body.originalInvoiceId !== undefined
  ) {
    if (body.timeEntryIds.length > 0 || body.expenseIds.length > 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Credit notes cannot bill time entries or expenses",
        }),
      );
    }
    const running = await guardRunningTimeEntries({
      tx,
      organizationId,
      workspaceId,
      actorUserId,
      selection: {
        type: "invoice",
        invoiceId: body.originalInvoiceId,
        runningCheck: "additional",
        additionalIds: [],
      },
    });
    if (running.isErr()) {
      return Result.err(running.error);
    }
    matterLocks = running.value;
  } else {
    const runningError = await guardRunningTimeEntries({
      tx,
      workspaceId,
      actorUserId,
      selection: { type: "entries", ids: body.timeEntryIds },
    });
    if (runningError) {
      return Result.err(runningError);
    }
  }
  const checked = await checkCreation(tx, {
    organizationId,
    workspaceId,
    body,
    matterLocks,
  });
  if (checked.isErr()) {
    return Result.err(checked.error);
  }
  const { flatFee, documentType, originalInvoiceId, originalScope } =
    checked.value;
  const defaults = await resolveCreationDefaults(tx, {
    organizationId,
    workspaceId,
    body,
    documentType,
    flatFee,
  });
  if (defaults.isErr()) {
    return Result.err(defaults.error);
  }
  const { prefill, taxableSupplyDate, dueDate, language } = defaults.value;
  if (prefill?.vat.reason === "no_vat_rate") {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "vat_rate_missing",
        message: "No VAT rate is in force on the invoice's supply date",
        hint: "Add a VAT rate covering the supply date in billing settings, then create the invoice again.",
      }),
    );
  }
  const adjusted = await applyEntryAdjustments(tx, {
    actorUserId,
    workspaceId,
    adjustments: body.entryAdjustments,
    memberRole,
    now,
    recordAuditEvent,
  });
  if (adjusted.isErr()) {
    return Result.err(adjusted.error);
  }
  // audit: skip - billCreatedDraft records the create event in this transaction
  const [created] = await tx
    .insert(invoices)
    .values({
      organizationId,
      workspaceId: originalScope?.workspaceId === null ? null : workspaceId,
      clientId: originalScope?.clientId ?? clientId,
      invoiceNumber: body.invoiceNumber ?? null,
      documentType,
      originalInvoiceId,
      billingMode: flatFee === null ? "hourly" : "flat_fee",
      flatFeeAmount: flatFee,
      invoiceDate: body.invoiceDate,
      dueDate,
      taxableSupplyDate,
      reference: body.reference ?? null,
      currency: body.currency,
      language,
      notes: body.notes ?? null,
      status: INVOICE_STATUS.DRAFT,
      sellerProfileId: prefill?.seller?.id ?? null,
      ...prefill?.buyer,
    })
    .returning({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
    });

  if (!created) {
    return panic("Invoice insert returned no row");
  }

  return await billCreatedDraft(tx, {
    actorUserId,
    created,
    body,
    workspaceId,
    organizationId,
    flatFee,
    vat:
      prefill === null
        ? ATTACHED_ENTRY_LINE_VAT
        : {
            vatTreatment: prefill.vat.vatTreatment,
            vatRateBps: prefill.vat.vatRateBps,
            exemptionReason: null,
          },
    documentType,
    originalInvoiceId,
    now,
    recordAuditEvent,
  });
};

export const invoiceCreationError = (error: SafeDbError | HandlerError) =>
  DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
    ? new HandlerError({
        status: 409,
        message: "An invoice with this number already exists",
      })
    : error;
