import { cents, type CentsAmount } from "@stll/money";

import { InvoicingInputError } from "./errors";
import type {
  InvoiceDocument,
  InvoiceDocumentInput,
  InvoiceDocumentType,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceTotals,
  VatBreakdownLine,
} from "./types";

const BASIS_POINTS_DENOMINATOR = 10_000n;

type CalculateDocumentTotalsInput = {
  documentType: InvoiceDocumentType;
  lines: InvoiceLineInput[];
};

export const calculateDocumentTotals = ({
  documentType,
  lines,
}: CalculateDocumentTotalsInput): {
  lines: InvoiceLine[];
  totals: InvoiceTotals;
} => {
  const calculatedLines: InvoiceLine[] = [];
  const breakdown = new Map<string, VatBreakdownLine>();
  let netAmountMinor = cents(0);
  let vatAmountMinor = cents(0);
  let grossAmountMinor = cents(0);

  for (const line of lines) {
    if (line.netAmountMinor < 0 || !Number.isSafeInteger(line.netAmountMinor)) {
      throw new InvoicingInputError({
        message: "Line net amount must be a non-negative minor amount",
      });
    }
    if (!Number.isSafeInteger(line.vatRateBps) || line.vatRateBps < 0) {
      throw new InvoicingInputError({
        message: "VAT rate must be non-negative integer basis points",
      });
    }

    const sign = documentType === "credit_note" ? -1 : 1;
    const lineVat =
      line.vatTreatment === "domestic_vat"
        ? calculateVatAmount(line.netAmountMinor, line.vatRateBps)
        : cents(0);
    const signedNet = cents(sign * line.netAmountMinor || 0);
    const signedVat = cents(sign * lineVat || 0);
    const signedGross = cents(signedNet + signedVat);
    calculatedLines.push({
      ...line,
      netAmountMinor: signedNet,
      vatAmountMinor: signedVat,
      grossAmountMinor: signedGross,
    });

    netAmountMinor = cents(netAmountMinor + signedNet);
    vatAmountMinor = cents(vatAmountMinor + signedVat);
    grossAmountMinor = cents(grossAmountMinor + signedGross);

    const key = `${line.vatTreatment}:${line.vatRateBps}`;
    const existing = breakdown.get(key);
    if (existing) {
      breakdown.set(key, {
        ...existing,
        netAmountMinor: cents(existing.netAmountMinor + signedNet),
        vatAmountMinor: cents(existing.vatAmountMinor + signedVat),
        grossAmountMinor: cents(existing.grossAmountMinor + signedGross),
      });
    } else {
      breakdown.set(key, {
        vatRateBps: line.vatRateBps,
        vatTreatment: line.vatTreatment,
        netAmountMinor: signedNet,
        vatAmountMinor: signedVat,
        grossAmountMinor: signedGross,
      });
    }
  }

  return {
    lines: calculatedLines,
    totals: {
      netAmountMinor,
      vatAmountMinor,
      grossAmountMinor,
      vatBreakdown: [...breakdown.values()],
    },
  };
};

export const createInvoiceDocument = (
  input: InvoiceDocumentInput,
): InvoiceDocument => {
  if (input.lines.length === 0) {
    throw new InvoicingInputError({
      message: "Invoice document requires at least one line",
    });
  }

  const { lines, totals } = calculateDocumentTotals(input);
  return { ...input, lines, totals };
};

export type CreateSingleLineDocumentInput = Omit<
  InvoiceDocumentInput,
  "lines"
> & {
  description: string;
  netAmountMinor: CentsAmount;
  vatRateBps: number;
};

export const createSingleLineDocument = ({
  description,
  netAmountMinor,
  vatRateBps,
  ...input
}: CreateSingleLineDocumentInput): InvoiceDocument =>
  createInvoiceDocument({
    ...input,
    lines: [
      {
        description,
        netAmountMinor,
        vatRateBps,
        vatTreatment: "domestic_vat",
      },
    ],
  });

const calculateVatAmount = (
  netAmountMinor: CentsAmount,
  vatRateBps: number,
): CentsAmount =>
  cents(
    Number(
      (BigInt(netAmountMinor) * BigInt(vatRateBps) +
        BASIS_POINTS_DENOMINATOR / 2n) /
        BASIS_POINTS_DENOMINATOR,
    ),
  );
