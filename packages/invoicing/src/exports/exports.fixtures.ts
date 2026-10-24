import { cents } from "@stll/money";

import { calculateDocumentTotals } from "../invoice-document";
import type { InvoiceDocumentType } from "../types";
import type {
  InvoiceExportLine,
  InvoiceExportRecord,
  InvoiceExportSeller,
} from "./record";

const SELLER: InvoiceExportSeller = {
  name: "Advokátní kancelář Novák & Partneři s.r.o.",
  registrationNumber: "12345678",
  vatId: "CZ12345678",
  addressLine1: "Vodičkova 700/30",
  city: "Praha",
  postalCode: "110 00",
  country: "CZ",
  iban: "CZ6508000000192000145399",
  bic: "GIBACZPX",
  accountNumber: "19-2000145399/0800",
  homeCurrency: "CZK",
};

const DEFAULT_MATTER = {
  id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e99",
  name: "Převod obchodního podílu",
  reference: "2026-0042",
};

type LineSeed = Partial<InvoiceExportLine> &
  Pick<InvoiceExportLine, "description" | "netAmountMinor">;

const line = (seed: LineSeed, position: number): InvoiceExportLine => {
  const vatRateBps = seed.vatRateBps ?? 2100;
  const vatAmountMinor = cents(
    Math.sign(seed.netAmountMinor) *
      Math.round((Math.abs(seed.netAmountMinor) * vatRateBps) / 10_000) || 0,
  );
  return {
    position,
    matter: DEFAULT_MATTER,
    quantity: "1.0000",
    unit: null,
    unitPriceMinor: seed.netAmountMinor,
    vatRateBps,
    vatTreatment: "domestic_vat",
    source: "manual",
    date: null,
    timekeeper: null,
    taskCode: null,
    activityCode: null,
    expenseCode: null,
    vatAmountMinor,
    grossAmountMinor: cents(seed.netAmountMinor + vatAmountMinor),
    ...seed,
  };
};

type RecordSeed = Partial<Omit<InvoiceExportRecord, "lines" | "totals">> & {
  number: string;
  lines: LineSeed[];
};

/** A finished export record whose totals are the package's own arithmetic. */
export const exportRecord = (seed: RecordSeed): InvoiceExportRecord => {
  const documentType: InvoiceDocumentType = seed.documentType ?? "invoice";
  const lines = seed.lines.map((entry, index) => line(entry, index + 1));
  const { totals } = calculateDocumentTotals({
    documentType,
    lines: lines.map((entry) => ({
      description: entry.description,
      // Records carry signed lines; the document arithmetic takes magnitudes
      // and signs a credit note itself.
      netAmountMinor: cents(Math.abs(entry.netAmountMinor)),
      vatRateBps: entry.vatRateBps,
      vatTreatment: entry.vatTreatment,
    })),
  }).unwrap("fixture lines have valid totals");
  return {
    id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e01",
    documentType,
    originalNumber: null,
    status: "finalized",
    issueDate: "2026-09-30",
    taxableSupplyDate: "2026-09-30",
    dueDate: "2026-10-14",
    paidDate: null,
    currency: "CZK",
    reference: null,
    notes: null,
    scope: { type: "matter", matter: DEFAULT_MATTER },
    seller: SELLER,
    buyer: {
      name: "Zelená louka a.s.",
      registrationNumber: "87654321",
      vatId: "CZ87654321",
      addressLine1: "Masarykova 12",
      city: "Brno",
      postalCode: "602 00",
      country: "CZ",
    },
    ...seed,
    lines,
    totals,
  };
};

export const DOMESTIC_INVOICE = exportRecord({
  number: "20260016",
  notes: "Právní služby za září 2026",
  lines: [
    {
      description: "Příprava smlouvy o převodu podílu & due diligence <A>",
      quantity: "4.5000",
      unit: "h",
      unitPriceMinor: cents(300_000),
      netAmountMinor: cents(1_350_000),
      source: "time_entry",
      date: "2026-09-12",
      timekeeper: { id: "user-1", name: "Jana Nováková" },
      taskCode: "L120",
      activityCode: "A103",
    },
    {
      description: "Soudní poplatek",
      netAmountMinor: cents(200_000),
      vatRateBps: 0,
      vatTreatment: "exempt",
      source: "expense",
      date: "2026-09-15",
      expenseCode: "E112",
    },
  ],
});

export const CREDIT_NOTE = exportRecord({
  id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e02",
  number: "20260017",
  documentType: "credit_note",
  originalNumber: "20260016",
  dueDate: null,
  lines: [
    {
      description: "Sleva z faktury 20260016",
      unitPriceMinor: cents(-100_000),
      netAmountMinor: cents(-100_000),
    },
  ],
});

export const MIXED_RATES_INVOICE = exportRecord({
  id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e03",
  number: "20230005",
  issueDate: "2023-11-30",
  taxableSupplyDate: "2023-11-30",
  dueDate: "2023-12-14",
  status: "paid",
  paidDate: "2023-12-10",
  lines: [
    { description: "Konzultace", netAmountMinor: cents(100_000) },
    {
      description: "Odborná publikace",
      netAmountMinor: cents(50_000),
      vatRateBps: 1000,
    },
    {
      description: "Ubytování",
      netAmountMinor: cents(80_000),
      vatRateBps: 1500,
    },
  ],
});

export const ADVANCE_INVOICE = exportRecord({
  id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e04",
  number: "Z2026001",
  documentType: "advance",
  taxableSupplyDate: null,
  lines: [
    { description: "Záloha na právní služby", netAmountMinor: cents(500_000) },
  ],
});

export const EURO_INVOICE = exportRecord({
  id: "0192d6a4-7c1e-7b55-9a3e-2f1b6c8d4e05",
  number: "20260018",
  currency: "EUR",
  buyer: {
    name: "Grüne Wiese GmbH",
    vatId: "DE123456789",
    addressLine1: "Hauptstraße 1",
    city: "München",
    postalCode: "80331",
    country: "DE",
  },
  lines: [
    {
      description: "Legal advice",
      netAmountMinor: cents(120_000),
      vatRateBps: 0,
      vatTreatment: "reverse_charge",
    },
  ],
});
