import type { CentsAmount } from "@stll/money";

export type InvoiceDocumentType = "invoice" | "advance" | "credit_note";

export type VatTreatment =
  | "domestic_vat"
  | "not_vat_payer"
  | "reverse_charge"
  | "exempt";

export type InvoiceParty = {
  name: string;
  registrationNumber?: string;
  taxId?: string;
  vatId?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  email?: string;
};

export type BankPaymentDetails = {
  iban?: string;
  bic?: string;
  accountNumber?: string;
  bankCode?: string;
  variableSymbol?: string;
  dueDate?: string;
  message?: string;
};

export type InvoiceLineInput = {
  description: string;
  netAmountMinor: CentsAmount;
  vatRateBps: number;
  vatTreatment: VatTreatment;
};

export type InvoiceLine = InvoiceLineInput & {
  vatAmountMinor: CentsAmount;
  grossAmountMinor: CentsAmount;
};

export type VatBreakdownLine = {
  vatRateBps: number;
  vatTreatment: VatTreatment;
  netAmountMinor: CentsAmount;
  vatAmountMinor: CentsAmount;
  grossAmountMinor: CentsAmount;
};

export type InvoiceTotals = {
  netAmountMinor: CentsAmount;
  vatAmountMinor: CentsAmount;
  grossAmountMinor: CentsAmount;
  vatBreakdown: VatBreakdownLine[];
};

export type InvoiceDocumentInput = {
  documentType: InvoiceDocumentType;
  number: string;
  issueDate: string;
  taxableSupplyDate?: string;
  dueDate?: string;
  currency: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLineInput[];
  payment?: BankPaymentDetails;
  notes?: string;
};

export type InvoiceDocument = Omit<InvoiceDocumentInput, "lines"> & {
  lines: InvoiceLine[];
  totals: InvoiceTotals;
};
