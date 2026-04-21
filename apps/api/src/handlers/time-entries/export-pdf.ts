import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { user } from "@/api/db/auth-schema";
import { timeEntryStatusSchema } from "@/api/db/billing-validators";
import { timeEntries } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";

export const exportPdfQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  status: t.Optional(timeEntryStatusSchema),
  matterId: t.Optional(t.String()),
});

type ExportPdfQuerySchema = Static<typeof exportPdfQuerySchema>;

type ExportPdfHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  query: ExportPdfQuerySchema;
};

/**
 * Generates a minimal PDF timesheet report using raw PDF syntax.
 * This avoids adding a PDF generation dependency.
 */
export const exportPdfHandler = async ({
  scopedDb,
  workspaceId,
  query,
}: ExportPdfHandlerProps) => {
  const conditions = [eq(timeEntries.workspaceId, workspaceId)];

  if (query.dateFrom) {
    conditions.push(gte(timeEntries.dateWorked, query.dateFrom));
  }
  if (query.dateTo) {
    conditions.push(lte(timeEntries.dateWorked, query.dateTo));
  }
  if (query.status) {
    conditions.push(eq(timeEntries.status, query.status));
  }
  if (query.matterId) {
    conditions.push(eq(timeEntries.matterId, query.matterId));
  }

  const rows = await scopedDb((tx) =>
    tx
      .select({
        id: timeEntries.id,
        userId: timeEntries.userId,
        matterId: timeEntries.matterId,
        dateWorked: timeEntries.dateWorked,
        durationMinutes: timeEntries.durationMinutes,
        billedMinutes: timeEntries.billedMinutes,
        rateAtEntry: timeEntries.rateAtEntry,
        currency: timeEntries.currency,
        narrative: timeEntries.narrative,
        billable: timeEntries.billable,
        status: timeEntries.status,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .orderBy(timeEntries.dateWorked)
      .limit(LIMITS.exportPdfRowLimit),
  );

  // Batch-fetch user names
  const userIds = new Set<string>();
  for (const row of rows) {
    if (row.userId) {
      userIds.add(row.userId);
    }
  }

  const usersResult =
    userIds.size > 0
      ? await scopedDb((tx) =>
          tx
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, [...userIds])),
        )
      : [];

  const userMap = new Map(usersResult.map((u) => [u.id, u.name]));

  // Build text content for the PDF
  const dateRange =
    query.dateFrom && query.dateTo
      ? `${query.dateFrom} to ${query.dateTo}`
      : (query.dateFrom ?? query.dateTo ?? "All dates");

  const textLines: string[] = [
    "TIMESHEET REPORT",
    "",
    `Period: ${dateRange}`,
    `Generated: ${new Date().toISOString().split("T")[0]}`,
    `Entries: ${rows.length}`,
    "",
    "-".repeat(80),
    "",
  ];

  let totalMinutes = 0;
  let totalAmount = 0;

  for (const row of rows) {
    const userName = row.userId
      ? (userMap.get(row.userId) ?? "Unknown")
      : "Unknown";
    const hours = (row.billedMinutes / 60).toFixed(2);
    const rate = (row.rateAtEntry / 100).toFixed(2);
    const amount = ((row.billedMinutes / 60) * (row.rateAtEntry / 100)).toFixed(
      2,
    );

    totalMinutes += row.durationMinutes;
    totalAmount += (row.billedMinutes / 60) * (row.rateAtEntry / 100);

    textLines.push(`Date: ${row.dateWorked}  User: ${userName}`);
    textLines.push(
      `Duration: ${hours}h  Rate: ${row.currency} ${rate}/hr  Amount: ${row.currency} ${amount}`,
    );
    textLines.push(
      `Status: ${row.status}  Billable: ${row.billable ? "Yes" : "No"}`,
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
  textLines.push(`Total Amount: ${totalAmount.toFixed(2)}`);

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
  const toAscii = (s: string) => s.replace(/[^\u0020-\u007E]/g, "?");

  // Escape special PDF characters in text
  const escPdf = (s: string) =>
    toAscii(s)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");

  // ~50 lines per page at 10pt with 14pt leading
  const linesPerPage = 50;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
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
