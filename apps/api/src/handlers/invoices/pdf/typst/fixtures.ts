import { cents } from "@stll/money";

import type { RenderInvoicePdfOptions } from "../render-helpers";

/** Every diacritic the Central European profiles need, in one string. */
export const CEE_DIACRITICS = "ěščřžýáíéůú ĚŠČŘŽ ľĺŕô ąćęłńóśźż őűŐŰ äöüß";

const line = (index: number) =>
  ({
    workspaceId: "matter-one",
    workspaceName: "Contract review",
    description: `Právní služby ${index + 1}: příprava podání, jednání s protistranou a revize smluvní dokumentace`,
    quantity: "2.5000",
    unit: "h",
    unitPrice: 250_000,
    netAmount: 625_000,
    vatAmount: 131_250,
    grossAmount: 756_250,
    vatRateBps: 2100,
    vatTreatment: "domestic_vat",
  }) as const;

export const invoiceFixture = (lineCount: number) =>
  ({
    invoice: {
      status: "finalized",
      documentType: "invoice",
      invoiceNumber: "2026-001",
      invoiceDate: "2026-09-30",
      dueDate: "2026-10-14",
      taxableSupplyDate: "2026-09-30",
      currency: "CZK",
      language: "cs",
      reference: "0987654321",
      notes: CEE_DIACRITICS,
      buyerName: "Řehoř Žďárský",
      buyerRegistrationId: "01234567",
      buyerTaxId: null,
      buyerVatId: "CZ01234567",
      buyerAddressLine1: "Příčná 12",
      buyerAddressLine2: null,
      buyerCity: "České Budějovice",
      buyerPostalCode: "370 01",
      buyerCountry: "CZ",
      lines: Array.from({ length: lineCount }, (_, index) => line(index)),
    },
    seller: {
      legalName: "Advokátní kancelář Černý",
      registrationId: "87654321",
      taxId: null,
      vatId: "CZ87654321",
      addressLine1: "Široká 4",
      addressLine2: null,
      city: "Praha",
      postalCode: "110 00",
      country: "CZ",
      iban: "CZ33 0100 0000 0000 0297 0297",
      bic: "KOMBCZPP",
      accountNumber: "2970297/0100",
      registerEntry: null,
      barRegistration: null,
      footerNotes: "Zapsáno v seznamu advokátů ČAK pod č. 12345.",
    },
    totals: {
      netAmountMinor: cents(625_000 * lineCount),
      vatAmountMinor: cents(131_250 * lineCount),
      grossAmountMinor: cents(756_250 * lineCount),
      vatBreakdown: [
        {
          vatTreatment: "domestic_vat",
          vatRateBps: 2100,
          netAmountMinor: cents(625_000 * lineCount),
          vatAmountMinor: cents(131_250 * lineCount),
          grossAmountMinor: cents(756_250 * lineCount),
        },
      ],
    },
    originalNumber: null,
  }) satisfies RenderInvoicePdfOptions;

export const DUMMY_ISDOC = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType>
  <ID>2026-001</ID>
</Invoice>
`;
