import { panic, Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";
import { parsePlainDate } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_BILLING_PURPOSE,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { claimInvoiceExpenses } from "@/api/handlers/invoices/entries/add";
import {
  ATTACHED_ENTRY_LINE_VAT,
  attachedEntryLineDrafts,
  type AttachedEntryLineDraftsOptions,
  insertInvoiceLines,
  type LineVat,
  manualLineDraft,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockBillingArrangement } from "@/api/lib/billing/arrangements";
import { resolveInvoicePrefill } from "@/api/lib/billing/invoice-prefill";
import { latestDate } from "@/api/lib/billing/invoice-prefill.logic";
import { canApproveTimeEntries } from "@/api/lib/billing/time-entry-authorization";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import {
  invoiceLanguageSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { CentsAmount } from "@/api/lib/money";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";

import { INVOICE_ENTRIES_MODIFIED_MESSAGE } from "./concurrent-modification";
import { tInvoiceDocumentType, validateInvoiceDocument } from "./document-type";

type InvoiceDocumentType = v.InferOutput<typeof tInvoiceDocumentType>;

const createInvoiceBodySchema = v.object({
  invoiceNumber: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  ),
  documentType: v.optional(tInvoiceDocumentType),
  originalInvoiceId: v.optional(resourceIdSchema("invoice")),
  invoiceDate: apiDateSchema,
  dueDate: v.optional(v.nullable(apiDateSchema)),
  reference: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
  currency: currencyCodeSchema,
  language: v.optional(invoiceLanguageSchema),
  notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(10_000)))),
  timeEntryIds: v.pipe(
    v.array(resourceIdSchema("timeEntry")),
    v.minLength(0),
    v.maxLength(500),
  ),
  expenseIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("expense")),
      v.minLength(0),
      v.maxLength(500),
      v.description(
        "Approved, billable, not-yet-invoiced expenses of the matter to bill on this invoice",
      ),
    ),
  ),
  entryAdjustments: v.optional(
    v.pipe(
      v.array(
        v.object({
          timeEntryId: resourceIdSchema("timeEntry"),
          billedMinutes: v.pipe(
            v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
            v.description(
              "Minutes to bill for the entry; its logged duration stays",
            ),
          ),
          noCharge: v.pipe(
            v.boolean(),
            v.description("Show the entry on the invoice at no charge"),
          ),
        }),
      ),
      v.maxLength(500),
      v.description(
        "Billed minutes and no-charge to set on entries in timeEntryIds before they are billed; needs approval rights",
      ),
    ),
  ),
  sellerProfileId: v.optional(resourceIdSchema("sellerProfile")),
  taxableSupplyDate: v.optional(v.nullable(apiDateSchema)),
  expectedTotalAmount: v.optional(
    v.pipe(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(-Number.MAX_SAFE_INTEGER),
        v.maxValue(Number.MAX_SAFE_INTEGER),
      ),
      v.description(
        "Gross total in minor units that the caller reviewed; the invoice is not created when the computed total differs",
      ),
    ),
  ),
});

/** Each attached entry moves from approved to billed on this invoice. */
const billedEntryEvents = (
  entries: readonly { id: SafeId<"timeEntry"> }[],
  invoiceId: SafeId<"invoice">,
) =>
  entries.map((entry) => ({
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
    resourceId: entry.id,
    changes: {
      status: { old: BILLING_STATUS.APPROVED, new: BILLING_STATUS.BILLED },
      invoiceId: { old: null, new: invoiceId },
    },
  }));

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
const createInvoiceInput = ({
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
  memberRole: AuthorizedMemberRole;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
type CheckCreationOptions = {
  workspaceId: SafeId<"workspace">;
  body: CreateInvoiceInput;
};
/** Everything that can refuse a create before anything is written. */
const checkCreation = async (
  tx: Transaction,
  { workspaceId, body }: CheckCreationOptions,
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
  const totalInvoices = await tx.$count(
    invoices,
    eq(invoices.workspaceId, workspaceId),
  );
  if (totalInvoices >= LIMITS.invoicesPerWorkspace) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invoice limit reached for this workspace",
      }),
    );
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
  return Result.ok({ flatFee, documentType, originalInvoiceId });
};

type BillCreatedDraftOptions = {
  actorUserId: SafeId<"user">;
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
const billCreatedDraft = async (
  tx: Transaction,
  {
    actorUserId,
    created,
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
  const updated = await tx
    .update(timeEntries)
    .set({
      invoiceId: created.id,
      invoiceAttachment:
        flatFee === null
          ? INVOICE_ATTACHMENT.CHARGED
          : INVOICE_ATTACHMENT.COVERED,
      status: BILLING_STATUS.BILLED,
      updatedAt: now,
    })
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        eq(timeEntries.activityGroup, TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
        inArray(timeEntries.id, body.timeEntryIds),
        eq(timeEntries.status, BILLING_STATUS.APPROVED),
        flatFee === null ? eq(timeEntries.billable, true) : undefined,
        isNull(timeEntries.invoiceId),
        // Repeat hourly eligibility in the atomic claim; covered work keeps its recorded currency.
        flatFee === null ? eq(timeEntries.currency, body.currency) : undefined,
      ),
    )
    .returning({
      id: timeEntries.id,
      dateWorked: timeEntries.dateWorked,
      billedMinutes: timeEntries.billedMinutes,
      rateAtEntry: timeEntries.rateAtEntry,
      narrative: timeEntries.narrative,
      invoiceNarrative: timeEntries.invoiceNarrative,
      noCharge: timeEntries.noCharge,
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
      action: AUDIT_ACTION.CREATE,
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
    ...billedEntryEvents(updated, created.id),
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
  await insertInvoiceLines(tx, { ...scope, organizationId }, lines, {
    recordAuditEvent,
  });
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
        message: `The invoice total is ${totalAmount} minor units, not the reviewed ${body.expectedTotalAmount}`,
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

const createDraftInvoice = async (
  tx: Transaction,
  {
    actorUserId,
    memberRole,
    organizationId,
    workspaceId,
    body,
    now,
    recordAuditEvent,
  }: CreateDraftInvoiceOptions,
): Promise<Result<CreateInvoiceResult, HandlerError>> => {
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "entries", ids: body.timeEntryIds },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  const checked = await checkCreation(tx, { workspaceId, body });
  if (checked.isErr()) {
    return Result.err(checked.error);
  }
  const { flatFee, documentType, originalInvoiceId } = checked.value;
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
      workspaceId,
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

const invoiceCreationError = (error: SafeDbError | HandlerError) =>
  DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
    ? new HandlerError({
        status: 409,
        message: "An invoice with this number already exists",
      })
    : error;

const createInvoice = createSafeHandler(
  {
    contract: "patch",
    idempotency: { type: "replay" },
    description:
      "Create a draft invoice from approved, not-yet-invoiced client time " +
      "entries in a matter, marking them billed. Hourly invoices require " +
      "billable entries in the invoice currency and calculate time charges " +
      "from their billed minutes and recorded rates; nothing is converted. The " +
      "optional invoice number must not already be in use. An omitted number " +
      "is allocated from the document type’s default series at finalize. Credit " +
      "notes require an original finalized, sent, or paid invoice in the same matter. " +
      "A flat-fee matter snapshots its agreed fee as one protected manual line; selected approved client entries are covered without time charges. Hourly matters reserve time charges against any cap and refuse an excess without write-down. " +
      "Pass empty timeEntryIds for a draft with manual lines. expenseIds bills " +
      "approved expenses in the same call. entryAdjustments sets billed minutes " +
      "and no-charge on included entries first (approvers only). The draft is " +
      "prefilled like invoices.prefill returns it: the default seller profile " +
      "(or sellerProfileId), the buyer copied from the matter's client, every " +
      "line's VAT from the seller's VAT-payer flag and the buyer (not a VAT payer, " +
      "reverse charge when the client's VAT ID names another country, or the highest organization VAT rate in force), the taxable " +
      "supply date as the last included work day, and the due date from the " +
      "client's payment term or 14 days; explicit dueDate and taxableSupplyDate win. " +
      "Without a seller profile, lines keep 0 % VAT. Credit notes are not prefilled.",
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: createInvoiceBodySchema,
  },
  async function* ({
    safeDb,
    user,
    memberRole,
    session,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      resultTx(
        safeDb,
        async (tx) =>
          await createDraftInvoice(tx, {
            actorUserId: user.id,
            memberRole,
            organizationId: session.activeOrganizationId,
            workspaceId,
            body: createInvoiceInput(body),
            now: new Date(),
            recordAuditEvent,
          }),
      ).then((txResult) => txResult.mapError(invoiceCreationError)),
    );
    return Result.ok(result);
  },
);

export default createInvoice;
