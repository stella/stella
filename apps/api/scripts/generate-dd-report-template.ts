/**
 * Generate the built-in "Due Diligence Report" DOCX asset.
 *
 * Bun-runnable: `bun apps/api/scripts/generate-dd-report-template.ts`.
 * Hand-builds the OOXML with JSZip (literal `{{...}}` / `{{#each}}` / `{{#if}}`
 * markers placed verbatim in paragraphs, which a structured document builder
 * would fight), then embeds the report manifest via `writeManifest` and writes
 * the committed asset the runtime loads.
 *
 * The template exercises the engine's report shape: an outer `{{#each contracts}}`
 * body loop, an inner row-repeat over `{{#each contracts.fields}}`, a
 * `{{#if contracts.hasRisks}}` block with a nested `{{#each contracts.risks}}`,
 * and AI-drafted `{{execSummary}}` / `{{contracts.summary}}` fields.
 */

import { writeManifest } from "@/api/handlers/docx/template-manifest";
import { DD_REPORT_MANIFEST } from "@/api/handlers/reports/builtin-templates";

const escXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const P = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;

const styledP = (text: string, style: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>` +
  `<w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p>`;

const TC = (...paragraphs: string[]): string =>
  `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphs.join("")}</w:tc>`;

const TR = (...cells: string[]): string => `<w:tr>${cells.join("")}</w:tr>`;

const TBL = (columnCount: number, ...rows: string[]): string =>
  '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
  '<w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
  `<w:tblGrid>${"<w:gridCol/>".repeat(columnCount)}</w:tblGrid>` +
  `${rows.join("")}</w:tbl>`;

// ── Report body (matches build-report-data.ts ReportData shape) ──────────────

const fieldsTable = TBL(
  3,
  TR(TC(P("Field")), TC(P("Value")), TC(P("Verdict"))),
  TR(
    TC(P("{{#each contracts.fields}}"), P("{{contracts.fields.label}}")),
    TC(P("{{contracts.fields.value}}")),
    TC(P("{{contracts.fields.verdict}}"), P("{{/each}}")),
  ),
);

const risksBlock =
  P("{{#if contracts.hasRisks}}") +
  styledP("Risks", "Heading3") +
  P("{{#each contracts.risks}}") +
  P(
    "[{{contracts.risks.severity}}] {{contracts.risks.issue}} — {{contracts.risks.verdict}}",
  ) +
  P("{{contracts.risks.rationale}}") +
  P("Citation: {{contracts.risks.citation}}") +
  P("{{/each}}") +
  P("{{/if}}");

// The per-contract summary is AI-drafted, so gate the heading AND the value on
// {{#if aiNarrative}}: a deterministic export (aiNarrative=false) drops both, so
// no empty "Summary" heading is left behind. The condition resolves the
// top-level `aiNarrative` flag even inside the contracts loop (the loop body's
// evaluation context inherits top-level data).
const contractSection =
  P("{{#each contracts}}") +
  styledP("{{contracts.name}}", "Heading2") +
  P(
    "Document type: {{contracts.documentType}} — Risk level: {{contracts.riskLevel}}",
  ) +
  fieldsTable +
  risksBlock +
  P("{{#if aiNarrative}}") +
  styledP("Summary", "Heading3") +
  P("{{contracts.summary}}") +
  P("{{/if}}") +
  P("{{/each}}");

// Annex: a consolidated docs × columns overview. The row-repeat clones one
// `w:tr` per contract (`{{#each grid.rows}}`), but the grammar has no
// cell-repeat, so a true dynamic-column matrix (one column per review column) is
// not renderable from a static template. The annex therefore uses two fixed
// columns — the contract name and a pre-joined "Label: value" summary cell
// (`grid.rows.summary`). The data object still carries the faithful
// `grid.columns`/`grid.rows.cells` matrix for callers that can consume it.
const annexTable = TBL(
  2,
  TR(TC(P("Contract")), TC(P("Review summary"))),
  TR(
    TC(P("{{#each grid.rows}}"), P("{{grid.rows.name}}")),
    TC(P("{{grid.rows.summary}}"), P("{{/each}}")),
  ),
);

const annexSection =
  styledP("Annex — Review matrix", "Heading1") +
  P(
    "A consolidated overview of every reviewed contract and its extracted columns.",
  ) +
  annexTable;

const bodyXml =
  styledP("Executive Summary", "Heading1") +
  // The narrative paragraph is AI-drafted; gate only it on {{#if aiNarrative}}.
  // The heading and the deterministic stats line below stay, so a fast export
  // still has content under "Executive Summary" (the stats), never an empty
  // heading or a literal {{execSummary}} marker.
  P("{{#if aiNarrative}}") +
  P("{{execSummary}}") +
  P("{{/if}}") +
  P(
    "Contracts reviewed: {{stats.total}} — Red flags: {{stats.redFlags}} (blocker {{stats.bySeverity.blocker}}, high {{stats.bySeverity.high}}, medium {{stats.bySeverity.medium}}, low {{stats.bySeverity.low}})",
  ) +
  P("Workspace: {{workspace.name}} — Generated: {{generatedAt}}") +
  styledP("Contract Review", "Heading1") +
  contractSection +
  annexSection;

const TITLE = "Due Diligence Report";

const createDocx = async (): Promise<Buffer> => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
  );

  zip
    .folder("_rels")
    ?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    );

  const word = zip.folder("word");
  word?.file(
    "document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${escXml(TITLE)}</w:t></w:r></w:p>` +
      `${bodyXml}</w:body></w:document>`,
  );
  word
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    );

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buffer);
};

const main = async (): Promise<void> => {
  const bare = await createDocx();
  const withManifest = await writeManifest(bare, DD_REPORT_MANIFEST);
  const outUrl = new URL(
    "../src/handlers/reports/assets/dd-report.docx",
    import.meta.url,
  );
  await Bun.write(outUrl, withManifest);
  // eslint-disable-next-line no-console -- generation script; stdout is its interface
  console.info(`[generate-dd-report-template] wrote ${outUrl.pathname}`);
};

await main();
