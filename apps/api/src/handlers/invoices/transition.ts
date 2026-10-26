import { panic, Result } from "better-result";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import * as v from "valibot";

import {
  INVOICE_COUNTRY_PROFILES,
  invoiceCountryOf,
  type InvoiceDocumentType,
  type VatRateCountry,
  vatRateReferenceDate,
  vatTaxPointDate,
} from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { resultTx } from "@/api/db/safe-db";
import type { SafeDbError } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_STATUS,
  invoiceLines,
  invoices,
  sellerProfiles,
  timeEntries,
} from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import {
  lockDraftInvoiceForLines,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { lockInvoiceInStatus } from "@/api/handlers/invoices/lock-invoice";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import {
  allocateNumber,
  findDefaultNumberSeries,
} from "@/api/lib/billing/number-series";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import {
  fetchVatExchangeRate,
  officialRateTransport,
  type VatExchangeRate,
  type VatExchangeRateError,
  type VatRateRequest,
} from "@/api/lib/billing/vat-exchange-rates";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { PG_ERROR } from "@/api/lib/pg-error";

type TransitionAction =
  "finalize" | "send" | "mark_paid" | "void" | "revert_to_draft";

const TRANSITIONS = {
  finalize: {
    from: [INVOICE_STATUS.DRAFT],
    to: INVOICE_STATUS.FINALIZED,
  },
  send: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.SENT,
  },
  mark_paid: {
    from: [INVOICE_STATUS.SENT],
    to: INVOICE_STATUS.PAID,
  },
  void: {
    from: [INVOICE_STATUS.FINALIZED, INVOICE_STATUS.SENT, INVOICE_STATUS.PAID],
    to: INVOICE_STATUS.VOID,
  },
  revert_to_draft: {
    from: [INVOICE_STATUS.FINALIZED],
    to: INVOICE_STATUS.DRAFT,
  },
} as const satisfies Record<
  TransitionAction,
  { from: InvoiceStatus[]; to: InvoiceStatus }
>;

const transitionInvoiceBodySchema = v.object({
  action: v.picklist([
    "finalize",
    "send",
    "mark_paid",
    "void",
    "revert_to_draft",
  ]),
});

const invoiceParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
});

const validateReverseChargeBuyer = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
  workspaceId: SafeId<"workspace">,
) => {
  const rows = await tx
    .select({ id: invoiceLines.id, buyerVatId: invoices.buyerVatId })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        eq(invoiceLines.vatTreatment, "reverse_charge"),
      ),
    )
    .limit(1);
  const reverseCharge = rows.at(0);
  return reverseCharge !== undefined &&
    (reverseCharge.buyerVatId ?? "").trim() === ""
    ? new HandlerError({
        status: 400,
        message: "Reverse charge requires a buyer VAT ID",
      })
    : null;
};

type PolishExemptionBasisOptions = {
  tx: Transaction;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  sellerProfileId: SafeId<"sellerProfile"> | null;
  organizationId: SafeId<"organization">;
};

const validatePolishExemptionBases = async ({
  tx,
  invoiceId,
  workspaceId,
  sellerProfileId,
  organizationId,
}: PolishExemptionBasisOptions) => {
  if (sellerProfileId === null) {
    return null;
  }
  const seller = await tx.query.sellerProfiles.findFirst({
    where: {
      id: { eq: sellerProfileId },
      organizationId: { eq: organizationId },
    },
    columns: { country: true, vatId: true },
  });
  if (seller === undefined || invoiceCountryOf(seller) !== "PL") {
    return null;
  }
  const missing = await tx
    .select({ treatment: invoiceLines.vatTreatment })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        inArray(invoiceLines.vatTreatment, ["exempt", "not_vat_payer"]),
        // The line schemas refuse blank bases (tExemptionReason).
        isNull(invoiceLines.exemptionReason),
      ),
    )
    .limit(1);
  const line = missing.at(0);
  return line === undefined
    ? null
    : new HandlerError({
        status: 400,
        message: `Polish ${line.treatment} invoice lines require an exemption basis`,
        hint: "Add the statutory exemption reason to every exempt or non-VAT-payer line, then finalize again.",
      });
};

type FinalizeTaxRequirementsOptions = PolishExemptionBasisOptions;

const validateFinalizeTaxRequirements = async (
  options: FinalizeTaxRequirementsOptions,
) =>
  (await validateReverseChargeBuyer(
    options.tx,
    options.invoiceId,
    options.workspaceId,
  )) ?? (await validatePolishExemptionBases(options));

const linkedCreditError = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
  workspaceId: SafeId<"workspace">,
) => {
  const credit = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.workspaceId, workspaceId),
        eq(invoices.originalInvoiceId, invoiceId),
        ne(invoices.status, INVOICE_STATUS.VOID),
      ),
    )
    .limit(1);
  return credit.at(0)
    ? new HandlerError({
        status: 409,
        message:
          "Void linked credit notes before changing their original invoice",
      })
    : null;
};

const buildVoidEvents = (params: {
  invoiceId: SafeId<"invoice">;
  previousStatus: InvoiceStatus;
  revertedTimeEntries: { id: SafeId<"timeEntry"> }[];
  revertedExpenses: { id: SafeId<"expense"> }[];
}): AuditEvent[] => {
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        status: { old: params.previousStatus, new: INVOICE_STATUS.VOID },
      },
    },
  ];
  for (const row of params.revertedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  for (const row of params.revertedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  return events;
};

type ReleaseInvoiceEntriesOptions = {
  actorUserId: SafeId<"user">;
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  previousStatus: InvoiceStatus;
  now: Date;
  recordAuditEvent: AuditRecorder;
};
const releaseInvoiceEntries = async (
  tx: Transaction,
  {
    invoiceId,
    workspaceId,
    previousStatus,
    now,
    recordAuditEvent,
    actorUserId,
  }: ReleaseInvoiceEntriesOptions,
) => {
  // The caller acquires these locks before the invoice; guard the release too.
  const runningError = await guardRunningTimeEntries({
    tx,
    workspaceId,
    actorUserId,
    selection: { type: "invoice", invoiceId },
  });
  if (runningError) {
    return Result.err(runningError);
  }
  const revertedTimeEntries = await tx
    .update(timeEntries)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
      updatedAt: now,
    })
    .where(
      and(
        eq(timeEntries.invoiceId, invoiceId),
        eq(timeEntries.workspaceId, workspaceId),
      ),
    )
    .returning({ id: timeEntries.id });

  const revertedExpenses = await tx
    .update(expenses)
    .set({
      status: BILLING_STATUS.APPROVED,
      invoiceId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(expenses.invoiceId, invoiceId),
        eq(expenses.workspaceId, workspaceId),
      ),
    )
    .returning({ id: expenses.id });

  // The voided document keeps its lines; releasing them lets the
  // entries they billed go on another invoice.
  await tx
    .update(invoiceLines)
    .set({ releasedAt: now, updatedAt: now })
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        isNull(invoiceLines.releasedAt),
      ),
    );

  await recordAuditEvent(
    tx,
    buildVoidEvents({
      invoiceId,
      previousStatus,
      revertedTimeEntries,
      revertedExpenses,
    }),
  );
  return Result.ok(undefined);
};

/** A finalize that reuses an issued number surfaces as a conflict. */
const duplicateInvoiceNumberError = (
  error: HandlerError | SafeDbError,
): HandlerError | null =>
  DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION
    ? new HandlerError({
        status: 409,
        message: "An invoice with this number already exists",
      })
    : null;

type VatRateSource = (
  request: Omit<VatRateRequest, "transport" | "today">,
) => ReturnType<typeof fetchVatExchangeRate>;

/** The finalize request is the boundary that issues authority to reach the official rate source. */
const officialVatRateSource: VatRateSource = async (request) =>
  await fetchVatExchangeRate({
    ...request,
    transport: officialRateTransport(grantThirdPartyOutboundPermit()),
  });

type VatRateInput = {
  country: VatRateCountry;
  currency: string;
  documentType: InvoiceDocumentType;
  invoiceDate: string;
  sellerCountry: string;
  taxableSupplyDate: string | null;
  taxPointDate: string;
  hasVat: true;
};

type ResolvedVatRate = {
  input: VatRateInput;
  rate: VatExchangeRate;
};

const vatRateHandlerError = (error: VatExchangeRateError) => {
  switch (error._tag) {
    case "VatRateCurrencyError":
      return new HandlerError({
        status: 422,
        message: "The invoice currency has no official VAT exchange rate",
        hint: "Use a currency published by the seller's official rate source, then finalize again.",
      });
    case "VatRateNotPublishedError":
      return new HandlerError({
        status: 409,
        message:
          "The official VAT exchange rate for this tax point is not published yet",
        hint: `Finalize once the rate for ${error.availableFrom} is published, or correct the taxable supply date.`,
      });
    case "VatRateMalformedError":
      return new HandlerError({
        code: "upstream_unavailable",
        status: 503,
        message: "The official VAT exchange-rate response could not be read",
        hint: "Retry finalizing later; if the problem continues, use the seller's home VAT currency.",
      });
    case "VatRateUnavailableError":
      return new HandlerError({
        code: "upstream_unavailable",
        status: 503,
        message: "The official VAT exchange-rate service is unavailable",
        hint: "Retry finalizing later; no changes were made to the invoice.",
      });
    default: {
      error satisfies never;
      return panic("Unknown VAT exchange-rate error");
    }
  }
};

type VatRatePreflight = {
  country: string | null;
  currency: string;
  documentType: InvoiceDocumentType;
  invoiceDate: string;
  taxableSupplyDate: string | null;
  statesVat: boolean;
  vatId: string | null;
};

const resolveVatRate = async (
  invoice: VatRatePreflight | undefined,
  rateSource: VatRateSource,
): Promise<Result<ResolvedVatRate | null, HandlerError>> => {
  if (!invoice?.country || !invoice.statesVat) {
    return Result.ok(null);
  }
  const country = invoiceCountryOf(invoice);
  const vatCurrency = INVOICE_COUNTRY_PROFILES[country].vatCurrency;
  if (
    country === "EU" ||
    vatCurrency === null ||
    vatCurrency === invoice.currency
  ) {
    return Result.ok(null);
  }
  // CZ § 42 and PL art. 31b prescribe correction-specific rates; foreign-currency credit notes are deliberately refused in this PR.
  if (invoice.documentType === "credit_note") {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "Foreign-currency credit notes cannot be finalized because correction exchange-rate rules differ",
        hint: "Issue the credit note in the seller's home VAT currency.",
      }),
    );
  }
  const dates = {
    country,
    invoiceDate: invoice.invoiceDate,
    taxableSupplyDate: invoice.taxableSupplyDate,
  };
  const taxPointDate = vatTaxPointDate(dates);
  const rate = await rateSource({
    country,
    currency: invoice.currency,
    referenceDate: vatRateReferenceDate(dates),
  });
  if (rate.isErr()) {
    return Result.err(vatRateHandlerError(rate.error));
  }
  return Result.ok({
    input: {
      country,
      currency: invoice.currency,
      documentType: invoice.documentType,
      invoiceDate: invoice.invoiceDate,
      sellerCountry: invoice.country,
      taxableSupplyDate: invoice.taxableSupplyDate,
      taxPointDate,
      hasVat: true,
    },
    rate: rate.value,
  });
};

type TransitionInvoiceDependencies = { rateSource: VatRateSource };

/**
 * Whether any line carries VAT. The rate decision reads the lines, not the
 * invoice's stored total, which can lag behind them.
 */
const invoiceStatesVat = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
) =>
  (
    await tx
      .select({ id: invoiceLines.id })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.invoiceId, invoiceId),
          ne(invoiceLines.vatAmount, cents(0)),
        ),
      )
      .limit(1)
  ).length > 0;

const storeResolvedVatRate = async (
  tx: Transaction,
  invoiceId: SafeId<"invoice">,
  resolved: ResolvedVatRate,
  set: Partial<typeof invoices.$inferInsert>,
) => {
  const current = await tx
    .select({
      currency: invoices.currency,
      documentType: invoices.documentType,
      invoiceDate: invoices.invoiceDate,
      taxableSupplyDate: invoices.taxableSupplyDate,
      sellerCountry: sellerProfiles.country,
    })
    .from(invoices)
    .leftJoin(sellerProfiles, eq(invoices.sellerProfileId, sellerProfiles.id))
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const row = current.at(0);
  const input = resolved.input;
  if (
    !row ||
    row.currency !== input.currency ||
    row.documentType !== input.documentType ||
    row.invoiceDate !== input.invoiceDate ||
    row.taxableSupplyDate !== input.taxableSupplyDate ||
    row.sellerCountry !== input.sellerCountry ||
    !(await invoiceStatesVat(tx, invoiceId))
  ) {
    return new HandlerError({
      status: 409,
      message: "The invoice changed while it was being finalized",
      hint: "Review the invoice and finalize again.",
    });
  }
  set.vatExchangeRate = resolved.rate.rate;
  set.vatExchangeRateSource = resolved.rate.source;
  set.vatExchangeRateDate = resolved.rate.effectiveDate;
  set.vatExchangeRateReference = resolved.rate.sourceReference;
  set.vatExchangeRateTaxPoint = input.taxPointDate;
  return null;
};

type UnconvertedVatOptions = {
  sellerProfileId: SafeId<"sellerProfile"> | null;
  organizationId: SafeId<"organization">;
  currency: string;
};

/**
 * Fail closed: a VAT invoice in a currency other than its seller country's VAT
 * currency is never issued without the official rate resolved before the write.
 */
const unconvertedVatError = async (
  tx: Transaction,
  { sellerProfileId, organizationId, currency }: UnconvertedVatOptions,
): Promise<HandlerError | null> => {
  if (sellerProfileId === null) {
    return null;
  }
  const seller = await tx.query.sellerProfiles.findFirst({
    where: {
      id: { eq: sellerProfileId },
      organizationId: { eq: organizationId },
    },
    columns: { country: true, vatId: true },
  });
  if (seller === undefined) {
    return null;
  }
  const { vatCurrency } = INVOICE_COUNTRY_PROFILES[invoiceCountryOf(seller)];
  if (vatCurrency === null || vatCurrency === currency) {
    return null;
  }
  return new HandlerError({
    status: 409,
    message: "The invoice's VAT changed while it was being finalized",
    hint: "Finalize again; the official exchange rate is resolved before the invoice is issued.",
  });
};

type ApplyTransitionOptions = {
  action: TransitionAction;
  actorUserId: SafeId<"user">;
  invoiceId: SafeId<"invoice">;
  now: Date;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  resolvedVatRate: ResolvedVatRate | null;
  transition: (typeof TRANSITIONS)[TransitionAction];
  workspaceId: SafeId<"workspace">;
};

const applyTransition = async (
  tx: Transaction,
  options: ApplyTransitionOptions,
): Promise<Result<{ id: SafeId<"invoice"> }, HandlerError>> => {
  if (options.action === "void" || options.action === "finalize") {
    const runningError = await guardRunningTimeEntries({
      tx,
      workspaceId: options.workspaceId,
      actorUserId: options.actorUserId,
      selection: { type: "invoice", invoiceId: options.invoiceId },
    });
    if (runningError) {
      return Result.err(runningError);
    }
  }
  const existing = await lockInvoiceInStatus(tx, {
    invoiceId: options.invoiceId,
    workspaceId: options.workspaceId,
    status: options.transition.from,
  });
  if (!existing) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: `Cannot ${options.action} invoice from its current status`,
      }),
    );
  }
  if (options.action === "void" || options.action === "revert_to_draft") {
    const creditError = await linkedCreditError(
      tx,
      existing.id,
      options.workspaceId,
    );
    if (creditError !== null) {
      return Result.err(creditError);
    }
  }
  const set: Partial<typeof invoices.$inferInsert> = {
    status: options.transition.to,
    updatedAt: options.now,
  };
  if (options.action === "mark_paid") {
    set.paidAt = options.now;
  }
  if (options.action === "void") {
    set.paidAt = null;
  }
  if (options.action === "revert_to_draft") {
    set.finalizedAt = existing.finalizedAt ?? options.now;
    set.vatExchangeRate = null;
    set.vatExchangeRateSource = null;
    set.vatExchangeRateDate = null;
    set.vatExchangeRateReference = null;
    set.vatExchangeRateTaxPoint = null;
  }
  if (options.action === "finalize") {
    if (options.resolvedVatRate !== null) {
      const changedError = await storeResolvedVatRate(
        tx,
        existing.id,
        options.resolvedVatRate,
        set,
      );
      if (changedError !== null) {
        return Result.err(changedError);
      }
    }
    const scope = {
      invoiceId: existing.id,
      workspaceId: options.workspaceId,
      organizationId: options.organizationId,
    };
    const draft = await lockDraftInvoiceForLines(
      tx,
      scope,
      options.recordAuditEvent,
    );
    if (draft.isErr()) {
      return Result.err(draft.error);
    }
    const taxRequirementsError = await validateFinalizeTaxRequirements({
      tx,
      invoiceId: existing.id,
      workspaceId: options.workspaceId,
      sellerProfileId: existing.sellerProfileId,
      organizationId: options.organizationId,
    });
    if (taxRequirementsError !== null) {
      return Result.err(taxRequirementsError);
    }
    const totals = await recalculateInvoiceTotals(
      tx,
      scope,
      options.now,
      options.recordAuditEvent,
    );
    if (totals.isErr()) {
      return Result.err(totals.error);
    }
    // The same predicate as the preflight: any VAT-bearing line, so buckets
    // whose VAT offsets to a zero total still need the rate.
    if (
      options.resolvedVatRate === null &&
      (await invoiceStatesVat(tx, existing.id))
    ) {
      const unconverted = await unconvertedVatError(tx, {
        sellerProfileId: existing.sellerProfileId,
        organizationId: options.organizationId,
        currency: existing.currency,
      });
      if (unconverted !== null) {
        return Result.err(unconverted);
      }
    }
    set.finalizedAt = existing.finalizedAt ?? options.now;
    if (existing.invoiceNumber === null) {
      const series = await findDefaultNumberSeries(
        tx,
        existing.documentType,
        existing.sellerProfileId,
      );
      if (!series) {
        return Result.err(
          new HandlerError({
            status: 409,
            message:
              "No default number series configured for this document type",
            hint: "Create a number series for this documentType and this seller or all sellers, set it as default, then finalize again.",
          }),
        );
      }
      const number = await allocateNumber(
        tx,
        series.id,
        new Date(`${existing.invoiceDate}T00:00:00Z`),
      );
      if (number.isErr()) {
        return Result.err(number.error);
      }
      set.invoiceNumber = number.value.number;
    }
  }
  const updated = await tx
    .update(invoices)
    .set(set)
    .where(
      and(
        eq(invoices.id, options.invoiceId),
        eq(invoices.workspaceId, options.workspaceId),
        inArray(invoices.status, options.transition.from),
      ),
    )
    .returning({ id: invoices.id });
  const row = updated.at(0);
  if (!row) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: `Cannot ${options.action} invoice from its current status`,
      }),
    );
  }
  if (options.action === "void") {
    const release = await releaseInvoiceEntries(tx, {
      actorUserId: options.actorUserId,
      invoiceId: row.id,
      workspaceId: options.workspaceId,
      previousStatus: existing.status,
      now: options.now,
      recordAuditEvent: options.recordAuditEvent,
    });
    if (release.isErr()) {
      return Result.err(release.error);
    }
    await recordBillingCapCrossings(tx, {
      workspaceId: options.workspaceId,
      recordAuditEvent: options.recordAuditEvent,
    });
  } else {
    await options.recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: row.id,
      changes: {
        status: { old: existing.status, new: options.transition.to },
        action: { old: null, new: options.action },
        ...(set.invoiceNumber !== undefined
          ? {
              invoiceNumber: {
                old: existing.invoiceNumber,
                new: set.invoiceNumber,
              },
            }
          : {}),
      },
    });
  }
  return Result.ok({ id: row.id });
};

const transitionInvoiceHandler = (rateSource: VatRateSource) =>
  createSafeHandler(
    {
      contract: "patch",
      description:
        "Move an invoice through finalize, send, mark_paid, void, or revert_to_draft. " +
        "Finalize assigns an omitted number from the document type's default series, " +
        "using the issue date; configure a default number series first. Manual numbers " +
        "and numbers kept after reverting to draft are preserved. A credit note must " +
        "reference an eligible original and cannot exceed its total. Voiding releases " +
        "attached entries and clears the paid timestamp. Finalizing a VAT invoice in a " +
        "currency other than its seller country's VAT currency (EUR for Slovakia, CZK " +
        "for Czechia, PLN for Poland) records the official exchange rate for its tax " +
        "point and states the VAT in that currency; it is refused when the rate cannot " +
        "be resolved.",
      permissions: { invoice: ["update"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      featureAccess: { featureId: "time-billing", type: "required" },
      realtime: invoiceRealtimeUpdates,
      mcp: {
        type: "capability",
        reason: "billing_admin",
        consumesServices: false,
      },
      params: invoiceParamsSchema,
      body: transitionInvoiceBodySchema,
    },
    async function* ({
      safeDb,
      user,
      session,
      workspaceId,
      params,
      body,
      recordAuditEvent,
    }) {
      const transition = TRANSITIONS[body.action];
      const now = new Date();
      let resolvedVatRate: ResolvedVatRate | null = null;
      if (body.action === "finalize") {
        const preflight = yield* Result.await(
          safeDb(async (tx) => {
            const row = (
              await tx
                .select({
                  currency: invoices.currency,
                  documentType: invoices.documentType,
                  invoiceDate: invoices.invoiceDate,
                  taxableSupplyDate: invoices.taxableSupplyDate,
                  country: sellerProfiles.country,
                  vatId: sellerProfiles.vatId,
                })
                .from(invoices)
                .leftJoin(
                  sellerProfiles,
                  eq(invoices.sellerProfileId, sellerProfiles.id),
                )
                .where(
                  and(
                    eq(invoices.id, params.invoiceId),
                    eq(invoices.workspaceId, workspaceId),
                  ),
                )
                .limit(1)
            ).at(0);
            return row === undefined
              ? undefined
              : {
                  ...row,
                  statesVat: await invoiceStatesVat(tx, params.invoiceId),
                };
          }),
        );
        resolvedVatRate = yield* Result.await(
          resolveVatRate(preflight, rateSource),
        );
      }
      const result = await resultTx(
        safeDb,
        async (tx) =>
          await applyTransition(tx, {
            action: body.action,
            actorUserId: user.id,
            invoiceId: params.invoiceId,
            now,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            resolvedVatRate,
            transition,
            workspaceId,
          }),
      );
      const conflict = result.isErr()
        ? duplicateInvoiceNumberError(result.error)
        : null;
      if (conflict !== null) {
        return Result.err(conflict);
      }
      const transitioned = yield* result;
      return Result.ok(transitioned);
    },
  );

export const createTransitionInvoice = ({
  rateSource = officialVatRateSource,
}: Partial<TransitionInvoiceDependencies> = {}) =>
  transitionInvoiceHandler(rateSource);

const transitionInvoice = createTransitionInvoice();

export default transitionInvoice;
