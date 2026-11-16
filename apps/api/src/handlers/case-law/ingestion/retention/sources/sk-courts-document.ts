/**
 * Retention projection for a Slovak general court decision's PDF.
 *
 * The `sk-courts` adapter stores listing metadata and builds no document, so
 * its policy is `unparsed` (see `sk-courts.ts`). The decision's text arrives
 * later: the document drain downloads the PDF, parses it and writes the
 * document onto the row outside the pipeline. The drain projects the bytes
 * it fetched through this module and runs the shared retention check on
 * what it stored, so those documents are measured as every pipeline
 * decision is.
 *
 * The projection is every line the PDF states, read with the PDF library
 * directly rather than through the parser's reader, except the publisher's
 * metadata table at the top of the first page. That table (court, docket,
 * file identifier, decision date, judge and ECLI) is listing metadata the
 * adapter stores as fields, and the parser rightly leaves it out of the
 * document. Its full form is six rows and close to thirty words, more than
 * the missing-word tolerance, so measured as text it would report every
 * decision that prints it as lost.
 *
 * Leaving it out hides no value: the publisher prints the table from the
 * record it lists, so a value the listing omits is an empty row in the PDF
 * (5Co/387/2010), and a table with an empty row is measured whole.
 */
import type { RetentionProjection } from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { projectPdfText } from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";

/**
 * A row of the publisher's metadata table: one of its labels, then a value.
 * Matched by label alone, independently of the parser, which also checks
 * the values against the listing.
 */
const METADATA_TABLE_ROW =
  /^(?:Súd|Spisová značka|Identifikačné číslo súdneho spisu|Dátum vydania rozhodnutia|Meno a priezvisko sudcu, VSÚ|ECLI): \S/u;
const METADATA_TABLE_END = /^ECLI: \S/u;

/**
 * The lines after the metadata table that opens the document. The table is
 * the leading run of labelled rows and must close with its ECLI row: without
 * that bound nothing is dropped, so a document that does not open with the
 * table, or opens with labelled lines that are not one, is measured whole.
 */
export const withoutMetadataTable = (
  lines: readonly string[],
): readonly string[] => {
  let end = 0;
  while (end < lines.length && METADATA_TABLE_ROW.test(lines[end] ?? "")) {
    end++;
  }
  const lastRow = lines[end - 1];
  return end > 0 && lastRow !== undefined && METADATA_TABLE_END.test(lastRow)
    ? lines.slice(end)
    : lines;
};

export const projectSkCourtsDocument = async (
  pdfBytes: Uint8Array,
): Promise<RetentionProjection> => {
  const projection = await projectPdfText(pdfBytes);
  if (projection.type !== "source" || typeof projection.source === "string") {
    return projection;
  }
  return {
    ...projection,
    source: {
      type: "paragraphs",
      paragraphs: withoutMetadataTable(projection.source.paragraphs),
    },
  };
};
