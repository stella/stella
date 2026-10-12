import { and, desc, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  contacts,
  sellerProfiles,
  vatRates,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import {
  buyerSnapshotFromContact,
  decideInvoiceVat,
  EMPTY_BUYER_SNAPSHOT,
  invoiceDueDays,
} from "./invoice-prefill.logic";
import { vatRateOnDate } from "./vat-rates";

type ResolveInvoicePrefillOptions = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** A seller profile the caller chose; the default profile otherwise. */
  sellerProfileId: SafeId<"sellerProfile"> | undefined;
  /** The taxable supply date, which decides the VAT rate in force. */
  supplyDate: string;
};

const SELLER_COLUMNS = {
  id: sellerProfiles.id,
  legalName: sellerProfiles.legalName,
  vatId: sellerProfiles.vatId,
  defaultCurrency: sellerProfiles.defaultCurrency,
} as const;

/**
 * What a new invoice in a matter starts from: the issuing seller profile, the
 * buyer copied from the matter's client, the VAT its lines get and the payment
 * term. Each value names where it came from so a person can check it. A
 * requested seller profile that is missing or archived resolves to `null`
 * with `sellerSource: "not_found"`; callers refuse it.
 */
export const resolveInvoicePrefill = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
    sellerProfileId,
    supplyDate,
  }: ResolveInvoicePrefillOptions,
) => {
  const [matter] = await tx
    .select({
      clientId: workspaces.clientId,
      clientName: contacts.displayName,
      registrationNumber: contacts.registrationNumber,
      taxId: contacts.taxId,
      billingAddress: contacts.billingAddress,
      addresses: contacts.addresses,
      paymentTermDays: contacts.paymentTermDays,
      clientCurrency: contacts.currency,
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
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    )
    .limit(1);
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
  const [standardRate] = await tx
    .select({ rateBps: vatRates.rateBps })
    .from(vatRates)
    .where(
      and(
        eq(vatRates.organizationId, organizationId),
        isNull(vatRates.archivedAt),
        vatRateOnDate(supplyDate),
      ),
    )
    .orderBy(desc(vatRates.rateBps))
    .limit(1);

  const buyer =
    matter?.clientName === null || matter?.clientName === undefined
      ? EMPTY_BUYER_SNAPSHOT
      : buyerSnapshotFromContact({
          displayName: matter.clientName,
          registrationNumber: matter.registrationNumber,
          taxId: matter.taxId,
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
    vat: decideInvoiceVat({
      seller: seller ?? null,
      buyerVatId: buyer.buyerVatId,
      buyerCountry: buyer.buyerCountry,
      standardRateBps: standardRate?.rateBps ?? null,
    }),
    dueDays: due.days,
    dueDaysSource: due.source,
  };
};

export type InvoicePrefill = Awaited<ReturnType<typeof resolveInvoicePrefill>>;
