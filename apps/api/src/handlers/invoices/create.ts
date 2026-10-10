import { panic, Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type Static, t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDbError } from "@/api/db/safe-db";
import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  INVOICE_ATTACHMENT,
  INVOICE_BILLING_PURPOSE,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import {
  ATTACHED_ENTRY_LINE_VAT,
  insertInvoiceLines,
  manualLineDraft,
  recalculateInvoiceTotals,
  timeEntryLineDraft,
} from "@/api/handlers/invoices/invoice-lines";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockBillingArrangement } from "@/api/lib/billing/arrangements";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tCurrencyCode, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { CentsAmount } from "@/api/lib/money";
import { PG_ERROR } from "@/api/lib/pg-error";

import { INVOICE_ENTRIES_MODIFIED_MESSAGE } from "./concurrent-modification";
import { tInvoiceDocumentType, validateInvoiceDocument } from "./document-type";

const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  documentType: t.Optional(tInvoiceDocumentType),
  originalInvoiceId: t.Optional(tSafeId("invoice")),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: tCurrencyCode,
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tSafeId("timeEntry"), {
    minItems: 0,
    maxItems: 500,
  }),
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
};
type InvoiceCreationEntryOptions = {
  workspaceId: SafeId<"workspace">;
  body: Static<typeof createInvoiceBodySchema>;
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
  return Result.ok(undefined);
};

const createInvoiceLineDrafts = (
  entries: readonly Parameters<typeof timeEntryLineDraft>[0][],
  flatFee: CentsAmount | null,
) => {
  if (flatFee === null) {
    return Result.ok(
      entries.map((entry) =>
        timeEntryLineDraft(entry, ATTACHED_ENTRY_LINE_VAT),
      ),
    );
  }
  return manualLineDraft({
    description: "Flat fee",
    quantity: "1",
    unit: null,
    unitPrice: flatFee,
    ...ATTACHED_ENTRY_LINE_VAT,
  }).map((fee) => [
    { ...fee, billingPurpose: INVOICE_BILLING_PURPOSE.FLAT_FEE } as const,
  ]);
};

type CreateDraftInvoiceOptions = {
  actorUserId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  body: Static<typeof createInvoiceBodySchema>;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
const createDraftInvoice = async (
  tx: Transaction,
  {
    actorUserId,
    organizationId,
    workspaceId,
    body,
    now,
    recordAuditEvent,
  }: CreateDraftInvoiceOptions,
): Promise<Result<CreateInvoiceResult, HandlerError>> => {
  const expectedCount = body.timeEntryIds.length;

  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "entries", ids: body.timeEntryIds },
  });
  if (runningError) {
    return Result.err(runningError);
  }
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
  if (documentType === "credit_note" && body.timeEntryIds.length > 0) {
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
      dueDate: body.dueDate ?? null,
      reference: body.reference ?? null,
      currency: body.currency,
      notes: body.notes ?? null,
      status: INVOICE_STATUS.DRAFT,
    })
    .returning({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
    });

  if (!created) {
    return panic("Invoice insert returned no row");
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
      billedMinutes: timeEntries.billedMinutes,
      rateAtEntry: timeEntries.rateAtEntry,
      narrative: timeEntries.narrative,
      invoiceNarrative: timeEntries.invoiceNarrative,
      noCharge: timeEntries.noCharge,
    });

  const linkedCount = updated.length;
  if (linkedCount !== expectedCount) {
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
            status: INVOICE_STATUS.DRAFT,
          },
        },
      },
    },
    ...billedEntryEvents(updated, created.id),
  ]);

  const scope = { invoiceId: created.id, workspaceId };
  const drafted = createInvoiceLineDrafts(updated, flatFee);
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

  return Result.ok({
    id: created.id,
    invoiceNumber: created.invoiceNumber,
    totalAmount,
    entryCount: linkedCount,
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
    description:
      "Create a draft invoice from approved, not-yet-invoiced client time " +
      "entries in a matter, marking them billed. Hourly invoices require " +
      "billable entries in the invoice currency and calculate time charges " +
      "from their billed minutes and recorded rates; nothing is converted. The " +
      "optional invoice number must not already be in use. An omitted number " +
      "is allocated from the document type’s default series at finalize. Credit " +
      "notes require an original finalized, sent, or paid invoice in the same matter. " +
      "A flat-fee matter snapshots its agreed fee as one protected manual line; selected approved client entries are covered without time charges. Hourly matters reserve time charges against any cap and refuse an excess without write-down. " +
      "Pass empty timeEntryIds for a draft with manual lines. Expenses are added " +
      "afterwards with invoices.entries.add.",
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
            organizationId: session.activeOrganizationId,
            workspaceId,
            body,
            now: new Date(),
            recordAuditEvent,
          }),
      ).then((txResult) => txResult.mapError(invoiceCreationError)),
    );
    return Result.ok(result);
  },
);

export default createInvoice;
