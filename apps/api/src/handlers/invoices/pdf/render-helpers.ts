import { panic } from "better-result";

import type { InvoiceLanguage, InvoiceStatus } from "@stll/api-contract";
import {
  buildCzechQrPaymentPayload,
  buildPolishQrPaymentPayload,
  normalizeIban,
  parseNip,
  variableSymbolOf,
} from "@stll/invoicing";
import type {
  CzechQrPaymentResult,
  InvoiceDocumentType,
  InvoiceTotals,
  InvoicingResult,
  PolishQrPaymentResult,
  VatTreatment,
} from "@stll/invoicing";
import { buildPayBySquarePayload } from "@stll/invoicing/pay-by-square";
import type { PayBySquareResult } from "@stll/invoicing/pay-by-square";
import { formatMoneyCents } from "@stll/money";
import { parsePlainDate } from "@stll/time";

export type RenderInvoicePdfOptions = {
  invoice: {
    status: InvoiceStatus;
    documentType: InvoiceDocumentType;
    invoiceNumber: string | null;
    invoiceDate: string;
    dueDate: string | null;
    taxableSupplyDate: string | null;
    currency: string;
    language: InvoiceLanguage;
    reference: string | null;
    notes: string | null;
    buyerName: string | null;
    buyerRegistrationId: string | null;
    buyerTaxId: string | null;
    buyerVatId: string | null;
    buyerAddressLine1: string | null;
    buyerAddressLine2: string | null;
    buyerCity: string | null;
    buyerPostalCode: string | null;
    buyerCountry: string | null;
    lines: {
      workspaceId: string;
      workspaceName: string;
      description: string;
      /** Null only on a line that was never billed by quantity. */
      quantity: string | null;
      unit: string | null;
      unitPrice: number | null;
      netAmount: number;
      vatAmount: number;
      grossAmount: number;
      vatRateBps: number;
      vatTreatment: VatTreatment;
      exemptionReason?: string | null;
    }[];
  };
  seller: {
    legalName: string;
    registrationId: string | null;
    taxId: string | null;
    vatId: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    iban: string | null;
    bic: string | null;
    accountNumber: string | null;
    registerEntry: string | null;
    barRegistration: string | null;
    footerNotes: string | null;
  } | null;
  totals: InvoiceTotals;
  originalNumber: string | null;
};

export const buildInvoicePaymentPayload = ({
  invoice,
  seller,
  totals,
}: RenderInvoicePdfOptions): InvoicingResult<
  | (CzechQrPaymentResult & { errorCorrection: "M"; scheme: "spayd" })
  | (PayBySquareResult & { errorCorrection: "M"; scheme: "pay_by_square" })
  | (PolishQrPaymentResult & { errorCorrection: "L"; scheme: "zbp" })
> | null => {
  if (
    invoice.documentType === "credit_note" ||
    totals.grossAmountMinor <= 0 ||
    !seller?.iban
  ) {
    return null;
  }
  const variableSymbol = variableSymbolOf({
    number: invoice.invoiceNumber ?? "",
    reference: invoice.reference,
  });
  const payment = {
    documentType: invoice.documentType,
    iban: seller.iban,
    amountMinor: totals.grossAmountMinor,
    currency: invoice.currency,
    ...(invoice.dueDate === null ? {} : { dueDate: invoice.dueDate }),
    ...(variableSymbol === null ? {} : { variableSymbol }),
    ...(invoice.status === "draft" || invoice.invoiceNumber === null
      ? {}
      : { message: invoice.invoiceNumber }),
  };
  const country = normalizeIban(seller.iban)?.slice(0, 2);
  if (country === "SK") {
    return buildPayBySquarePayload({
      ...payment,
      ...(seller.bic === null ? {} : { bic: seller.bic }),
      beneficiaryName: seller.legalName,
    }).map((result) => ({
      ...result,
      errorCorrection: "M" as const,
      scheme: "pay_by_square" as const,
    }));
  }
  if (country === "PL") {
    const nip = seller.vatId === null ? null : parseNip(seller.vatId);
    if (nip === null) {
      return null;
    }
    return buildPolishQrPaymentPayload({
      documentType: payment.documentType,
      iban: payment.iban,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      recipientNip: nip,
      recipientName: seller.legalName,
      title: payment.message ?? invoice.reference ?? "Faktura",
    }).map((result) => ({
      ...result,
      errorCorrection: "L" as const,
      scheme: "zbp" as const,
    }));
  }
  return buildCzechQrPaymentPayload(payment).map((result) => ({
    ...result,
    errorCorrection: "M" as const,
    scheme: "spayd" as const,
  }));
};

/**
 * Locale formatting for the Typst invoice data builder.
 */
export const createInvoiceFormatters = ({
  currency,
  locale,
}: {
  currency: string;
  locale: string;
}) => {
  const money = (amountCents: number) =>
    formatMoneyCents({ amountCents, currency, locale });
  const date = (value: string) => {
    const parsed =
      parsePlainDate(value) ??
      panic("Invoice contains an invalid calendar date");
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(parsed.toZonedDateTime("UTC").epochMilliseconds);
  };
  const vatRate = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(value / 10_000);
  const quantityFormat = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 4,
  });
  // Stored quantities are decimal strings with up to four decimals. One that
  // a double cannot hold exactly is printed as stored, never rounded.
  const quantity = (value: string) => {
    const [whole = "", decimals = ""] = value.split(".");
    let kept = decimals.length;
    while (kept > 0 && decimals[kept - 1] === "0") {
      kept -= 1;
    }
    const canonical =
      kept === 0 ? whole : `${whole}.${decimals.slice(0, kept)}`;
    const parsed = Number(canonical);
    return String(parsed) === canonical
      ? quantityFormat.format(parsed)
      : canonical;
  };
  return { money, date, vatRate, quantity };
};
