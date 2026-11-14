import { panic, Result } from "better-result";

import { ZipArchive } from "@stll/docx-core/zip";
import {
  buildEso9Table,
  buildFlexibeeXml,
  buildInvoiceLinesTable,
  buildInvoiceSummaryTable,
  buildIsdocFiles,
  buildKsefFa3Files,
  buildLedes1998b,
  buildMoneyS3Xml,
  buildPeppolSkFiles,
  buildPohodaXml,
  buildUblFiles,
} from "@stll/invoicing";
import type {
  InvoiceExportRecord,
  InvoiceTable,
  InvoiceTableCell,
  InvoiceTableLanguage,
  InvoicingInputError,
} from "@stll/invoicing";

import { exportAmountText } from "@/api/lib/billing/export-amount";
import { buildXlsxExport } from "@/api/lib/views/table-export";
import type { ExportTableInput } from "@/api/lib/views/table-export";
import { XLSX_MIME_TYPE } from "@/api/mime-types";

export const INVOICE_EXPORT_FORMATS = [
  "xlsx",
  "xlsx_lines",
  "pohoda",
  "money_s3",
  "flexibee",
  "isdoc",
  "ubl",
  "peppol_sk",
  "ksef_fa3",
  "eso9",
  "ledes_1998b",
] as const;

type InvoiceExportFormat = (typeof INVOICE_EXPORT_FORMATS)[number];

export type InvoiceExportFile = {
  body: Uint8Array;
  contentType: string;
  extension: string;
};

const XML_MIME_TYPE = "application/xml";
const ZIP_MIME_TYPE = "application/zip";

type ExportCell = ExportTableInput["rows"][number][number];

const exportCell = (cell: InvoiceTableCell): ExportCell => {
  if (cell.type === "text") {
    return { type: "text", value: cell.value, style: "default" };
  }
  if (cell.type === "number") {
    return {
      type: "number",
      value: cell.value,
      displayValue: String(cell.value),
      currency: null,
      style: "default",
    };
  }
  const displayValue = exportAmountText(cell.amountMinor, cell.currency);
  return {
    type: "number",
    value: Number(displayValue),
    displayValue,
    currency: cell.currency,
    style: "default",
  };
};

const tableInput = (table: InvoiceTable): ExportTableInput => ({
  columns: table.headers.map((header) => ({ header })),
  rows: table.rows.map((row) => row.map(exportCell)),
});

const xlsx = async (
  table: InvoiceTable,
  worksheetName: string,
): Promise<InvoiceExportFile> => ({
  body: new Uint8Array(
    await buildXlsxExport({ ...tableInput(table), worksheetName }),
  ),
  contentType: XLSX_MIME_TYPE,
  extension: "xlsx",
});

const textFile = (
  content: string,
  contentType: string,
  extension: string,
): InvoiceExportFile => ({
  body: new TextEncoder().encode(content),
  contentType,
  extension,
});

type BuildInvoiceExportOptions = {
  format: InvoiceExportFormat;
  records: readonly InvoiceExportRecord[];
  lang: InvoiceTableLanguage;
  packageId: string;
};

/** The export file for issued invoices in one of the supported formats. */
export const buildInvoiceExportFile = async ({
  format,
  records,
  lang,
  packageId,
}: BuildInvoiceExportOptions): Promise<
  Result<InvoiceExportFile, InvoicingInputError>
> => {
  switch (format) {
    case "xlsx":
      return Result.ok(
        await xlsx(buildInvoiceSummaryTable(records, lang), "Invoices"),
      );
    case "xlsx_lines":
      return Result.ok(
        await xlsx(buildInvoiceLinesTable(records, lang), "Invoice lines"),
      );
    case "eso9":
      return Result.ok(await xlsx(buildEso9Table(records), "Worksheet"));
    case "pohoda":
      return buildPohodaXml(records, packageId).map((xml) =>
        textFile(xml, XML_MIME_TYPE, "xml"),
      );
    case "money_s3":
      return buildMoneyS3Xml(records).map((xml) =>
        textFile(xml, XML_MIME_TYPE, "xml"),
      );
    case "flexibee":
      return buildFlexibeeXml(records).map((xml) =>
        textFile(xml, XML_MIME_TYPE, "xml"),
      );
    case "ledes_1998b":
      return buildLedes1998b(records).map((ledes) =>
        textFile(ledes, "text/plain; charset=utf-8", "txt"),
      );
    case "isdoc": {
      const files = buildIsdocFiles(records);
      return files.isErr()
        ? Result.err(files.error)
        : Result.ok(await documentsFile(files.value, "isdoc"));
    }
    case "ubl": {
      const files = buildUblFiles(records);
      return files.isErr()
        ? Result.err(files.error)
        : Result.ok(await documentsFile(files.value, "xml"));
    }
    case "peppol_sk": {
      const files = buildPeppolSkFiles(records);
      return files.isErr()
        ? Result.err(files.error)
        : Result.ok(await documentsFile(files.value, "xml"));
    }
    case "ksef_fa3": {
      const files = buildKsefFa3Files(records, new Date());
      return files.isErr()
        ? Result.err(files.error)
        : Result.ok(await documentsFile(files.value, "xml"));
    }
    default: {
      format satisfies never;
      return panic("Unknown invoice export format");
    }
  }
};

/**
 * The entry name for a file, numbered when an earlier entry took it: two
 * invoice numbers can sanitize to the same name, and a zip keeps only the
 * last file under one name.
 */
const uniqueEntryName = (fileName: string, taken: Set<string>): string => {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : "";
  // Case-insensitive file systems would still merge FV_1.xml and fv_1.xml.
  let name = fileName;
  for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) {
    name = `${stem}-${copy}${extension}`;
  }
  taken.add(name.toLowerCase());
  return name;
};

/** One e-invoice as itself; several as a zip of one file each. */
const documentsFile = async (
  files: readonly { fileName: string; content: string }[],
  extension: string,
): Promise<InvoiceExportFile> => {
  const [only, ...rest] = files;
  if (only && rest.length === 0) {
    return textFile(only.content, XML_MIME_TYPE, extension);
  }
  const zip = new ZipArchive();
  const taken = new Set<string>();
  for (const file of files) {
    zip.set(uniqueEntryName(file.fileName, taken), file.content);
  }
  return {
    body: await zip.generate(),
    contentType: ZIP_MIME_TYPE,
    extension: "zip",
  };
};
