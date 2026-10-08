import { Result } from "better-result";
import { and } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { timeEntryAmount, MoneyTotals } from "@stll/money";
import { Temporal, todayFor } from "@stll/time";

import { timeEntries } from "@/api/db/schema";
import { exportAmountText } from "@/api/handlers/time-entries/export-amount";
import {
  loadTimekeeperNames,
  timeEntryExportConditions,
  timeEntryExportQuerySchema,
} from "@/api/handlers/time-entries/export-query";
import type { TimeEntryExportHandlerProps } from "@/api/handlers/time-entries/export-query";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { readOrganizationTimeZone } from "@/api/lib/organization-time-zone";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * Generates a minimal PDF timesheet report using raw PDF syntax.
 * This avoids adding a PDF generation dependency.
 */
export const exportPdfHandler = async ({
  scopedDb,
  workspaceId,
  organizationId,
  query,
  at = Temporal.Now.instant(),
}: TimeEntryExportHandlerProps) => {
  const conditions = timeEntryExportConditions({ workspaceId, query });

  const { rows, timeZone } = await scopedDb(async (tx) => ({
    timeZone: await readOrganizationTimeZone(tx, organizationId),
    rows: await tx
      .select({
        id: timeEntries.id,
        activityGroup: timeEntries.activityGroup,
        userId: timeEntries.userId,
        dateWorked: timeEntries.dateWorked,
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        noCharge: timeEntries.noCharge,
        currency: timeEntries.currency,
        narrative: timeEntries.narrative,
        billable: timeEntries.billable,
        status: timeEntries.status,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .orderBy(timeEntries.dateWorked)
      .limit(LIMITS.exportPdfRowLimit),
  }));

  const userMap = await loadTimekeeperNames({
    scopedDb,
    organizationId,
    rows,
  });

  // Build text content for the PDF
  const dateRange =
    query.dateFrom && query.dateTo
      ? `${query.dateFrom} to ${query.dateTo}`
      : (query.dateFrom ?? query.dateTo ?? "All dates");

  const textLines: string[] = [
    "TIMESHEET REPORT",
    "",
    `Period: ${dateRange}`,
    `Generated: ${todayFor(timeZone, at).toString()}`,
    `Entries: ${rows.length}`,
    "",
    "-".repeat(80),
    "",
  ];

  let totalMinutes = 0;
  const totalAmountByCurrency = new MoneyTotals();

  for (const row of rows) {
    const userName = row.userId
      ? (userMap.get(row.userId) ?? "Unknown")
      : "Unknown";
    const hours = (row.billedMinutes / 60).toFixed(2);
    const rate = exportAmountText(row.rateAtEntry, row.currency);
    const amount = timeEntryAmount(row);

    // Total Hours must reconcile with the per-row billed hours and the
    // amount, which are both derived from billedMinutes; summing raw
    // durationMinutes here produced a total that did not match the lines.
    totalMinutes += row.billedMinutes;
    totalAmountByCurrency.add(row.currency, amount);

    textLines.push(`Date: ${row.dateWorked}  User: ${userName}`);
    textLines.push(
      `Duration: ${hours}h  Rate: ${row.currency} ${rate}/hr  Amount: ${row.currency} ${exportAmountText(amount, row.currency)}`,
    );
    textLines.push(
      `Activity group: ${row.activityGroup}  Status: ${row.status}  Billable: ${row.billable ? "Yes" : "No"}`,
    );

    // Truncate narrative for PDF
    const narrative =
      row.narrative.length > 120
        ? `${row.narrative.slice(0, 117)}...`
        : row.narrative;
    textLines.push(`Description: ${narrative}`);
    textLines.push("");
  }

  textLines.push("-".repeat(80));
  const totalHours = (totalMinutes / 60).toFixed(2);
  textLines.push(`Total Hours: ${totalHours}`);
  for (const { currency, amountCents } of totalAmountByCurrency.entries()) {
    textLines.push(
      `Total Amount: ${currency} ${exportAmountText(amountCents, currency)}`,
    );
  }

  return buildMinimalPdf(textLines);
};

/**
 * Builds a minimal valid PDF from an array of text lines.
 * Uses Helvetica (built-in PDF font, no embedding needed).
 * All text is restricted to ASCII since Helvetica (Type1)
 * only supports WinAnsiEncoding; this also ensures
 * string.length === byte length for correct xref offsets.
 */
const buildMinimalPdf = (lines: readonly string[]): Uint8Array => {
  const enc = new TextEncoder();

  // Replace non-ASCII characters with '?' since Helvetica
  // cannot render them; keeps string length === byte length.
  const toAscii = (s: string) => s.replace(/[^\u0020-\u007E]/gu, "?");

  // Escape special PDF characters in text
  const escPdf = (s: string) =>
    toAscii(s)
      .replace(/\\/gu, "\\\\")
      .replace(/\(/gu, "\\(")
      .replace(/\)/gu, "\\)");

  // ~50 lines per page at 10pt with 14pt leading
  const linesPerPage = 50;
  const pages = chunkItems(lines, linesPerPage);
  if (pages.length === 0) {
    pages.push(["No data"]);
  }

  // Build PDF objects
  const objects: string[] = [];
  const offsets: number[] = [];

  // Object 1: Catalog
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  // Object 2: Pages
  const pageObjStartIdx = 3;
  const pageRefs = pages
    .map((_, i) => `${pageObjStartIdx + i * 2} 0 R`)
    .join(" ");
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>\nendobj\n`,
  );

  // For each page: Page object + Content stream
  let objNum = 3;
  for (const pageLines of pages) {
    const pageObjNum = objNum;
    const streamObjNum = objNum + 1;

    // Build content stream
    let stream = "BT\n/F1 10 Tf\n";
    let y = 780;
    for (const line of pageLines) {
      stream += `1 0 0 1 36 ${y} Tm\n(${escPdf(line)}) Tj\n`;
      y -= 14;
    }
    stream += "ET\n";

    const streamBytes = enc.encode(stream);

    objects.push(
      `${pageObjNum} 0 obj\n` +
        "<< /Type /Page /Parent 2 0 R " +
        "/MediaBox [0 0 612 792] " +
        `/Contents ${streamObjNum} 0 R ` +
        "/Resources << /Font << /F1 " +
        "<< /Type /Font /Subtype /Type1 " +
        "/BaseFont /Helvetica >> >> >> >>\n" +
        "endobj\n",
    );

    objects.push(
      `${streamObjNum} 0 obj\n` +
        `<< /Length ${streamBytes.length} >>\n` +
        `stream\n${stream}endstream\n` +
        "endobj\n",
    );

    objNum += 2;
  }

  // Assemble PDF
  let pdf = "%PDF-1.4\n";
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }

  const xrefOffset = pdf.length;
  const totalObjs = objects.length + 1; // +1 for object 0
  pdf += "xref\n";
  pdf += `0 ${totalObjs}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += "trailer\n";
  pdf += `<< /Size ${totalObjs} /Root 1 0 R >>\n`;
  pdf += "startxref\n";
  pdf += `${xrefOffset}\n`;
  pdf += "%%EOF\n";

  return enc.encode(pdf);
};

const config = {
  accountAccess: ACCOUNT_ACCESS.standard,
  featureAccess: { featureId: "time-billing", type: "required" },
  description:
    "Render a matter's client time entries as a PDF timesheet report: one block per " +
    "entry plus total hours and totals per currency. Filter by date-worked " +
    "range, status, and work item. Returns PDF bytes; use " +
    "time-entries.csv.export to get the same entries as text.",
  permissions: { timeEntry: ["approve"] },
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "read",
  transport: {
    type: "file-response",
    response: { mediaTypes: [PDF_MIME_TYPE] },
    alternative: {
      type: "partial",
      // One sufficient call, not a sequence: `via` is an ordered list of calls
      // to make, and naming both exports here would tell a client to run the
      // second one for nothing. LEDES is named in the limitation as the other
      // single-call option.
      via: ["time-entries.csv.export"],
      limitation:
        "returns the same entries as CSV text (time-entries.ledes.export returns LEDES instead); the rendered PDF is not produced",
    },
  },
  query: timeEntryExportQuerySchema,
} satisfies WorkspaceHandlerConfig;

const exportPdf = createSafeHandler(
  config,
  async function* ({ query, scopedDb, session, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await exportPdfHandler({
            workspaceId,
            organizationId: session.activeOrganizationId,
            query,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default exportPdf;
