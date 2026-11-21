import * as v from "valibot";

/**
 * A structured invoice as its file states it. Amounts, quantities, rates and
 * codes are the source's own literals, never recomputed or reformatted; dates
 * are ISO calendar dates where the syntax writes them compactly. A value the
 * file does not state is null.
 */
const stated = v.nullable(v.string());

export const E_INVOICE_SYNTAXES = ["isdoc", "fatturaPA", "ubl", "cii"] as const;

export const E_INVOICE_DOCUMENT_TYPES = [
  "invoice",
  "creditNote",
  "debitNote",
  "advance",
  "other",
] as const;

/** What a party identifier is; `scheme` keeps the source's own scheme code. */
export const E_INVOICE_IDENTIFIER_KINDS = [
  "vat",
  "tax",
  "registration",
  "other",
] as const;

const partySchema = v.object({
  name: stated,
  identifiers: v.array(
    v.object({
      kind: v.picklist(E_INVOICE_IDENTIFIER_KINDS),
      scheme: stated,
      value: v.string(),
    }),
  ),
  /** Address lines in the source's order: street, city with postcode, country. */
  address: v.array(v.string()),
});

export const eInvoiceSchema = v.object({
  documentType: v.picklist(E_INVOICE_DOCUMENT_TYPES),
  /** The source's own type code, such as `380`, `TD01` or ISDOC `1`. */
  typeCode: stated,
  number: stated,
  issueDate: stated,
  taxPointDate: stated,
  dueDate: stated,
  currency: stated,
  seller: partySchema,
  buyer: partySchema,
  lines: v.array(
    v.object({
      id: stated,
      description: stated,
      quantity: stated,
      unitCode: stated,
      unitPrice: stated,
      vatRate: stated,
      vatCategory: stated,
      netAmount: stated,
    }),
  ),
  /** Lines the file holds; more than `lines` when the preview was cut short. */
  lineCount: v.number(),
  vatBreakdown: v.array(
    v.object({
      rate: stated,
      category: stated,
      taxableAmount: stated,
      taxAmount: stated,
      exemptionReason: stated,
    }),
  ),
  totals: v.object({
    netAmount: stated,
    taxAmount: stated,
    grossAmount: stated,
    prepaidAmount: stated,
    payableAmount: stated,
  }),
  payments: v.array(
    v.object({
      /** The source's payment means code (UNTDID 4461, FatturaPA `MP..`). */
      meansCode: stated,
      dueDate: stated,
      amount: stated,
      iban: stated,
      bic: stated,
      accountNumber: stated,
      bankCode: stated,
      reference: stated,
    }),
  ),
  notes: v.array(v.string()),
});

/** One file's invoices: an Italian batch carries several, other syntaxes one. */
export const eInvoicePreviewSchema = v.object({
  syntax: v.picklist(E_INVOICE_SYNTAXES),
  version: stated,
  invoices: v.array(eInvoiceSchema),
  /** Files the invoice embeds or packages; `index` opens one. */
  attachments: v.array(
    v.object({
      index: v.number(),
      fileName: v.string(),
      description: stated,
      sizeBytes: v.number(),
    }),
  ),
});

export type EInvoice = v.InferOutput<typeof eInvoiceSchema>;
export type EInvoicePreview = v.InferOutput<typeof eInvoicePreviewSchema>;
