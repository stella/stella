import { panic } from "better-result";

import type { InvoiceLanguage, InvoiceStatus } from "@stll/api-contract";
import {
  buildCzechQrPaymentPayload,
  buildPayBySquarePayload,
  paymentQrSchemeFor,
  variableSymbolOf,
} from "@stll/invoicing";
import type {
  InvoiceDocumentType,
  InvoiceTotals,
  VatTreatment,
} from "@stll/invoicing";
import { formatMoneyCents, toMajorUnits } from "@stll/money";
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
}: RenderInvoicePdfOptions) => {
  if (
    invoice.documentType === "credit_note" ||
    totals.grossAmountMinor <= 0 ||
    !seller?.iban
  ) {
    return null;
  }
  const scheme = paymentQrSchemeFor({
    iban: seller.iban,
    currency: invoice.currency,
  });
  const variableSymbol = variableSymbolOf({
    number: invoice.invoiceNumber ?? "",
    reference: invoice.reference,
  });
  switch (scheme) {
    case "spayd":
      return buildCzechQrPaymentPayload({
        documentType: invoice.documentType,
        iban: seller.iban,
        amountMinor: totals.grossAmountMinor,
        currency: invoice.currency,
        ...(invoice.dueDate === null ? {} : { dueDate: invoice.dueDate }),
        ...(variableSymbol === null ? {} : { variableSymbol }),
        ...(invoice.status === "draft" || invoice.invoiceNumber === null
          ? {}
          : { message: invoice.invoiceNumber }),
      });
    case "pay_by_square": {
      if (invoice.dueDate === null) {
        return null;
      }
      return buildPayBySquarePayload({
        amount: toMajorUnits({
          amountCents: totals.grossAmountMinor,
          currency: invoice.currency,
        }),
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        ...(variableSymbol === null ? {} : { variableSymbol }),
        paymentNote:
          invoice.status === "draft" || invoice.invoiceNumber === null
            ? ""
            : invoice.invoiceNumber,
        iban: seller.iban,
        ...(seller.bic === null ? {} : { bic: seller.bic }),
        beneficiaryName: seller.legalName,
      });
    }
    case null:
      return null;
    default: {
      scheme satisfies never;
      return panic("Unknown payment QR scheme");
    }
  }
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
