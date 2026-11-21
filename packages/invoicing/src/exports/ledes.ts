import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import {
  amountText,
  invoiceDescriptionOf,
  type InvoiceExportLine,
  type InvoiceExportRecord,
  quantityText,
} from "./record";

// LEDES 1998B: one pipe-delimited record per invoice line, each closed by
// "[]", under a fixed 24-field header. Amounts exclude tax; invoice-level
// fields repeat on every line of the invoice.

const HEADER = [
  "INVOICE_DATE",
  "INVOICE_NUMBER",
  "CLIENT_ID",
  "LAW_FIRM_MATTER_ID",
  "INVOICE_TOTAL",
  "BILLING_START_DATE",
  "BILLING_END_DATE",
  "INVOICE_DESCRIPTION",
  "LINE_ITEM_NUMBER",
  "EXP/FEE/INV_ADJ_TYPE",
  "LINE_ITEM_NUMBER_OF_UNITS",
  "LINE_ITEM_ADJUSTMENT_AMOUNT",
  "LINE_ITEM_TOTAL",
  "LINE_ITEM_DATE",
  "LINE_ITEM_TASK_CODE",
  "LINE_ITEM_EXPENSE_CODE",
  "LINE_ITEM_ACTIVITY_CODE",
  "TIMEKEEPER_ID",
  "LINE_ITEM_DESCRIPTION",
  "LAW_FIRM_ID",
  "LINE_ITEM_UNIT_COST",
  "TIMEKEEPER_NAME",
  "TIMEKEEPER_CLASSIFICATION",
  "CLIENT_MATTER_ID",
] as const;

/**
 * The format has no quoting, so a pipe or line break inside a value would
 * split a field or start a spurious record; both become spaces.
 */
const field = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/[\r\n|]+/gu, " ")
    .replace(/\[\]/gu, "[ ]")
    .replace(/\s{2,}/gu, " ")
    .trim();

const ledesDate = (date: string | null): string =>
  date === null ? "" : date.replaceAll("-", "");

/** F fee, E expense; a negative manual line is an invoice fee adjustment. */
const lineType = (line: InvoiceExportLine): string => {
  if (line.source === "expense") {
    return "E";
  }
  if (line.source === "manual" && line.netAmountMinor < 0) {
    return "IF";
  }
  return "F";
};

const records = (record: InvoiceExportRecord): string[] => {
  const amount = (value: number) => amountText(value, record.currency);
  const dates = record.lines
    .map((line) => line.date ?? record.issueDate)
    .toSorted();
  const start = ledesDate(dates.at(0) ?? record.issueDate);
  const end = ledesDate(dates.at(-1) ?? record.issueDate);
  const lawFirmId = record.seller.vatId ?? record.seller.registrationNumber;
  return record.lines.map((line, index) => {
    const type = lineType(line);
    const fields = [
      ledesDate(record.issueDate),
      record.number,
      record.buyer.registrationNumber ?? record.buyer.vatId ?? "",
      line.matter.reference ?? line.matter.id,
      amount(record.totals.netAmountMinor),
      start,
      end,
      invoiceDescriptionOf(record) ?? line.matter.name,
      String(index + 1),
      type,
      quantityText(line.quantity),
      "0",
      amount(line.netAmountMinor),
      ledesDate(line.date ?? record.issueDate),
      type === "E" ? "" : line.taskCode,
      type === "E" ? line.expenseCode : "",
      type === "E" ? "" : line.activityCode,
      line.timekeeper?.id ?? "",
      line.description,
      lawFirmId,
      amount(line.unitPriceMinor ?? line.netAmountMinor),
      line.timekeeper?.name ?? "",
      "",
      "",
    ];
    return `${fields.map(field).join("|")}[]`;
  });
};

/** Issued invoices as one LEDES 1998B file, an invoice's lines together. */
export const buildLedes1998b = (
  invoices: readonly InvoiceExportRecord[],
): InvoicingResult<string> => {
  if (invoices.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  const body = invoices.flatMap(records);
  return Result.ok(
    `${["LEDES1998B[]", `${HEADER.join("|")}[]`, ...body].join("\r\n")}\r\n`,
  );
};
