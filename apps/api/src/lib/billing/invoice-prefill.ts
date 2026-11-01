import { panic } from "better-result";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  invoiceCountryOf,
  invoiceSellerCountryOf,
  standardVatRateOn,
  vatRatePeriodsForCountry,
} from "@stll/invoicing";
import type { VatRatePeriod } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  organizationSettings,
  sellerProfiles,
  vatRates,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";

import { invoiceLanguageForCountry } from "./invoice-language";
import {
  buyerSnapshotFromContact,
  decideInvoiceVat,
  EMPTY_BUYER_SNAPSHOT,
  invoiceDueDays,
} from "./invoice-prefill.logic";

type ResolveInvoicePrefillOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** A seller profile the caller chose; the default profile otherwise. */
  sellerProfileId: SafeId<"sellerProfile"> | undefined;
  /** The taxable supply date, which decides the VAT rate in force. */
  supplyDate: string;
};

// An organization keeps a handful of rate periods; a partial list would pick
// the wrong rate, so exceeding this is a defect, not a page boundary.
const VAT_RATE_PERIOD_LIMIT = 200;

export const invoiceLanguageForSeller = (
  seller: {
    country: string | null;
    vatId: string | null;
  } | null,
) =>
  invoiceLanguageForCountry(
    invoiceSellerCountryOf(seller ?? { country: null, vatId: null }),
  );

const SELLER_COLUMNS = {
  id: sellerProfiles.id,
  legalName: sellerProfiles.legalName,
  vatId: sellerProfiles.vatId,
  vatPayer: sellerProfiles.vatPayer,
  defaultCurrency: sellerProfiles.defaultCurrency,
  country: sellerProfiles.country,
} as const;

/**
 * What a new invoice in a matter starts from: the issuing seller profile, the
 * buyer copied from the matter's client, the VAT its lines get and the payment
 * term. Each value names where it came from so a person can check it. A
 * requested seller profile that is missing or archived resolves to `null`
 * with `sellerSource: "not_found"`; callers refuse it.
 */
/** The organization's rates that apply to the seller's country, as periods. */
const sellerVatRatePeriods = (
  periods: readonly {
    code: string;
    validFrom: string;
    validTo: string | null;
    rateBps: number;
  }[],
  seller: { country: string | null; vatId: string | null } | null,
): VatRatePeriod[] =>
  vatRatePeriodsForCountry(
    periods,
    invoiceCountryOf(seller ?? { country: null, vatId: null }),
  ).map(({ validFrom, validTo, rateBps }) => ({ validFrom, validTo, rateBps }));

export const readInvoicePrefillContext = async (
  tx: Transaction,
  {
    organizationId,
    workspaceIds,
    sellerProfileId,
  }: Omit<ResolveInvoicePrefillOptions, "workspaceId" | "supplyDate"> & {
    workspaceIds: readonly SafeId<"workspace">[];
  },
) => {
  const matters = await tx
    .select({
      workspaceId: workspaces.id,
      clientId: workspaces.clientId,
      clientName: contacts.displayName,
      registrationNumber: contacts.registrationNumber,
      taxId: contacts.taxId,
      vatId: contacts.vatId,
      vatPayer: contacts.vatPayer,
      billingAddress: contacts.billingAddress,
      addresses: contacts.addresses,
      paymentTermDays: contacts.paymentTermDays,
      clientCurrency: contacts.currency,
      clientInvoiceLanguage: contacts.invoiceLanguage,
      organizationInvoiceLanguage: organizationSettings.invoiceLanguage,
    })
    .from(workspaces)
    .leftJoin(
      contacts,
      and(
        eq(contacts.id, workspaces.clientId),
        eq(contacts.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        inArray(workspaces.id, workspaceIds),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .limit(workspaceIds.length);
  const [seller] = await tx
    .select(SELLER_COLUMNS)
    .from(sellerProfiles)
    .where(
      and(
        eq(sellerProfiles.organizationId, organizationId),
        isNull(sellerProfiles.archivedAt),
        sellerProfileId === undefined
          ? eq(sellerProfiles.isDefault, true)
          : eq(sellerProfiles.id, sellerProfileId),
      ),
    )
    .limit(1);
  // Every period is returned so a client can re-resolve the rate when the
  // supply date moves with the selected work.
  const periodRead = await readBounded(
    tx
      .select({
        code: vatRates.code,
        validFrom: vatRates.validFrom,
        validTo: vatRates.validTo,
        rateBps: vatRates.rateBps,
      })
      .from(vatRates)
      .where(
        and(
          eq(vatRates.organizationId, organizationId),
          isNull(vatRates.archivedAt),
        ),
      )
      .orderBy(desc(vatRates.validFrom)),
    VAT_RATE_PERIOD_LIMIT,
  );
  const vatRatePeriods = sellerVatRatePeriods(
    periodRead.type === "complete"
      ? periodRead.rows
      : panic(
          `An organization keeps more than ${VAT_RATE_PERIOD_LIMIT} VAT rate periods`,
        ),
    seller ?? null,
  );

  return {
    matters: new Map(matters.map((matter) => [matter.workspaceId, matter])),
    seller: seller ?? null,
    sellerProfileId,
    vatRatePeriods,
  };
};

type ResolveInvoicePrefillContextOptions = Pick<
  ResolveInvoicePrefillOptions,
  "workspaceId" | "supplyDate"
>;

export const resolveInvoicePrefillContext = (
  {
    matters,
    seller,
    sellerProfileId,
    vatRatePeriods,
  }: Awaited<ReturnType<typeof readInvoicePrefillContext>>,
  { workspaceId, supplyDate }: ResolveInvoicePrefillContextOptions,
) => {
  const matter = matters.get(workspaceId);
  const buyer =
    matter?.clientName === null || matter?.clientName === undefined
      ? EMPTY_BUYER_SNAPSHOT
      : buyerSnapshotFromContact({
          displayName: matter.clientName,
          registrationNumber: matter.registrationNumber,
          taxId: matter.taxId,
          vatId: matter.vatId,
          vatPayer: matter.vatPayer,
          billingAddress: matter.billingAddress,
          addresses: matter.addresses,
        });
  let sellerSource: "requested" | "default" | "none" | "not_found" = "none";
  if (seller) {
    sellerSource = sellerProfileId === undefined ? "default" : "requested";
  } else if (sellerProfileId !== undefined) {
    sellerSource = "not_found";
  }
  const due = invoiceDueDays(matter?.paymentTermDays ?? null);
  return {
    seller: seller ?? null,
    sellerSource,
    buyer,
    buyerSource:
      buyer.buyerName === null ? ("none" as const) : ("client" as const),
    clientId: matter?.clientId ?? null,
    clientCurrency: matter?.clientCurrency ?? null,
    language:
      matter?.clientInvoiceLanguage ??
      matter?.organizationInvoiceLanguage ??
      invoiceLanguageForSeller(seller ?? null),
    vat: decideInvoiceVat({
      seller: seller ?? null,
      buyerVatId: buyer.buyerVatId,
      buyerVatPayer: matter?.vatPayer ?? null,
      buyerCountry: buyer.buyerCountry,
      standardRateBps: standardVatRateOn(vatRatePeriods, supplyDate),
    }),
    vatRatePeriods,
    dueDays: due.days,
    dueDaysSource: due.source,
  };
};

export const resolveInvoicePrefill = async (
  tx: Transaction,
  { workspaceId, supplyDate, ...options }: ResolveInvoicePrefillOptions,
) =>
  resolveInvoicePrefillContext(
    await readInvoicePrefillContext(tx, {
      ...options,
      workspaceIds: [workspaceId],
    }),
    { workspaceId, supplyDate },
  );
