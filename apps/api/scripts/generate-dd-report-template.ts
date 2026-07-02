/**
 * Generate the built-in "Due Diligence Report" DOCX asset.
 *
 * Bun-runnable: `bun apps/api/scripts/generate-dd-report-template.ts`.
 * Hand-builds the OOXML with JSZip (literal `{{...}}` / `{{#each}}` / `{{#if}}`
 * markers placed verbatim in paragraphs, which a structured document builder
 * would fight), then embeds the report manifest via `writeManifest` and writes
 * the committed asset the runtime loads.
 *
 * The layout is a conservative law-firm due-diligence memo: a serif body, a
 * navy title/heading hierarchy backed by a real `styles.xml`, a page-1 cover
 * block (confidentiality notice, title, subtitle, rule), a running header and a
 * "Page X of Y" footer, and bordered/shaded tables. It exercises the engine's
 * report shape: an outer `{{#each contracts}}` body loop, TWO variants of the
 * per-contract field table (with vs. without a Verdict column) selected by a
 * block `{{#if hasVerdicts}}/{{#else}}/{{/if}}` (whole tables pruned by the
 * block-unit `{{#if}}` engine), an inner row-repeat over
 * `{{#each contracts.fields}}`, block `{{#if}}` gates on per-contract flags
 * (`hasDocumentType`, `hasRiskLevel`, `hasRisks`), a `{{#each contracts.risks}}`
 * block, and AI-drafted `{{execSummary}}` / `{{contracts.summary}}` fields.
 */

import { writeManifest } from "@/api/handlers/docx/template-manifest";
import { DD_REPORT_MANIFEST } from "@/api/handlers/reports/builtin-templates";

const escXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// ── Palette / metrics (twentieths-of-a-point unless noted) ───────────────────

const NAVY = "1F3864";
const NEAR_BLACK = "262626";
const GRAY = "808080";
const MID_GRAY = "595959";
const BORDER_GRAY = "BFBFBF";
const LABEL_FILL = "F2F2F2";
const WHITE = "FFFFFF";

/** A4 text width with 1440-twip (1 in) side margins: 11906 − 2 × 1440. */
const TEXT_WIDTH = 9026;

// ── Run / paragraph helpers ──────────────────────────────────────────────────

const run = (text: string, rPr = ""): string =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}` +
  `<w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;

/** Plain body paragraph. Used for the directive marker lines the engine strips. */
const P = (text: string): string => `<w:p>${run(text)}</w:p>`;

const styledP = (text: string, style: string, rPr = ""): string =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(text, rPr)}</w:p>`;

/** A tight, bold body paragraph (the risk lead line). */
const boldLeadP = (text: string): string =>
  `<w:p><w:pPr><w:spacing w:before="80" w:after="20"/></w:pPr>${run(text, "<w:b/>")}</w:p>`;

/** Full-width navy horizontal rule (an empty bottom-bordered paragraph). */
const RULE =
  "<w:p><w:pPr><w:pBdr>" +
  `<w:bottom w:val="single" w:sz="8" w:space="1" w:color="${NAVY}"/>` +
  '</w:pBdr><w:spacing w:before="80" w:after="280"/></w:pPr></w:p>';

// ── Table helpers ────────────────────────────────────────────────────────────

const VALUE_RPR = '<w:sz w:val="20"/><w:szCs w:val="20"/>';
const LABEL_RPR = '<w:b/><w:sz w:val="20"/><w:szCs w:val="20"/>';
const HEADER_RPR = `<w:b/><w:color w:val="${WHITE}"/><w:sz w:val="20"/><w:szCs w:val="20"/>`;

const CELL_SPACING =
  '<w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/>';

const HEADER_TRPR = "<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>";
const ROW_TRPR = "<w:trPr><w:cantSplit/></w:trPr>";

const TBL_BORDERS = `<w:tblBorders>${[
  "top",
  "left",
  "bottom",
  "right",
  "insideH",
  "insideV",
]
  .map(
    (side) =>
      `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${BORDER_GRAY}"/>`,
  )
  .join("")}</w:tblBorders>`;

const TBL_CELL_MAR =
  "<w:tblCellMar>" +
  '<w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>' +
  '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/>' +
  "</w:tblCellMar>";

/** A cell paragraph with tight table spacing. */
const cellP = (text: string, rPr = VALUE_RPR): string =>
  `<w:p><w:pPr>${CELL_SPACING}</w:pPr>${run(text, rPr)}</w:p>`;

type CellOptions = { width: number; fill?: string };

/** A table cell holding pre-built paragraphs (so directive marker paragraphs can
 *  ride along and be stripped by the loop engine). */
const cell = (options: CellOptions, ...paragraphs: string[]): string => {
  const shd = options.fill
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>`
    : "";
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${options.width}" w:type="dxa"/>${shd}` +
    '<w:vAlign w:val="center"/></w:tcPr>' +
    `${paragraphs.join("")}</w:tc>`
  );
};

/** A shaded navy header cell with white bold text. */
const headerCell = (width: number, text: string): string =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
  `<w:shd w:val="clear" w:color="auto" w:fill="${NAVY}"/>` +
  '<w:vAlign w:val="center"/></w:tcPr>' +
  `<w:p><w:pPr>${CELL_SPACING}</w:pPr>${run(text, HEADER_RPR)}</w:p></w:tc>`;

const row = (trPr: string, ...cells: string[]): string =>
  `<w:tr>${trPr}${cells.join("")}</w:tr>`;

const table = (widths: number[], ...rows: string[]): string => {
  const total = widths.reduce((sum, width) => sum + width, 0);
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
    `<w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/>` +
    `${TBL_BORDERS}${TBL_CELL_MAR}</w:tblPr>` +
    `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    `${rows.join("")}</w:tbl>`
  );
};

// ── Executive summary ────────────────────────────────────────────────────────

const LABEL_COL = 2900;
const VALUE_COL = TEXT_WIDTH - LABEL_COL;

const statsRow = (label: string, path: string): string =>
  row(
    ROW_TRPR,
    cell({ width: LABEL_COL, fill: LABEL_FILL }, cellP(label, LABEL_RPR)),
    cell({ width: VALUE_COL }, cellP(`{{${path}}}`)),
  );

// ONE label/value stats table with no header band (the shaded label column
// carries the structure). The red-flag/severity rows are verdict-only, and the
// engine cannot gate individual rows INSIDE a table (a block {{#if}} whose
// markers sit in different rows strips only the marker paragraphs, leaving
// ghost rows and empty cells — verified against processBlockDirectives), so
// the gate selects between two whole-table variants, same as the field table.
const statsTableFull = table(
  [LABEL_COL, VALUE_COL],
  statsRow("Contracts reviewed", "stats.total"),
  statsRow("Red flags", "stats.redFlags"),
  statsRow("Blocker", "stats.bySeverity.blocker"),
  statsRow("High", "stats.bySeverity.high"),
  statsRow("Medium", "stats.bySeverity.medium"),
  statsRow("Low", "stats.bySeverity.low"),
);

const statsTableBasic = table(
  [LABEL_COL, VALUE_COL],
  statsRow("Contracts reviewed", "stats.total"),
);

const statsBlock =
  P("{{#if hasVerdicts}}") +
  statsTableFull +
  P("{{#else}}") +
  statsTableBasic +
  P("{{/if}}");

const execSummarySection =
  styledP("Executive Summary", "Heading1") +
  // The narrative paragraph is AI-drafted; gate only it on {{#if aiNarrative}}
  // so a deterministic export keeps the heading and the stats below.
  P("{{#if aiNarrative}}") +
  styledP("{{execSummary}}", "BodyText") +
  P("{{/if}}") +
  statsBlock;

// ── Per-contract field table (two variants) ──────────────────────────────────

const FIELD_LABEL_COL = 2900;

// With a Verdict column (hasVerdicts): Field | Value | Verdict.
const fieldsTableWithVerdict = (() => {
  const valueCol = 3760;
  const verdictCol = TEXT_WIDTH - FIELD_LABEL_COL - valueCol;
  return table(
    [FIELD_LABEL_COL, valueCol, verdictCol],
    row(
      HEADER_TRPR,
      headerCell(FIELD_LABEL_COL, "Field"),
      headerCell(valueCol, "Value"),
      headerCell(verdictCol, "Verdict"),
    ),
    row(
      ROW_TRPR,
      cell(
        { width: FIELD_LABEL_COL, fill: LABEL_FILL },
        P("{{#each contracts.fields}}"),
        cellP("{{contracts.fields.label}}", LABEL_RPR),
      ),
      cell({ width: valueCol }, cellP("{{contracts.fields.value}}")),
      cell(
        { width: verdictCol },
        cellP("{{contracts.fields.verdict}}"),
        P("{{/each}}"),
      ),
    ),
  );
})();

// Without a Verdict column (no playbook): Field | Value. Emitting a separate
// variant keeps the losing branch from leaving a dead empty Verdict column.
const fieldsTableNoVerdict = (() => {
  const valueCol = TEXT_WIDTH - FIELD_LABEL_COL;
  return table(
    [FIELD_LABEL_COL, valueCol],
    row(
      HEADER_TRPR,
      headerCell(FIELD_LABEL_COL, "Field"),
      headerCell(valueCol, "Value"),
    ),
    row(
      ROW_TRPR,
      cell(
        { width: FIELD_LABEL_COL, fill: LABEL_FILL },
        P("{{#each contracts.fields}}"),
        cellP("{{contracts.fields.label}}", LABEL_RPR),
      ),
      cell(
        { width: valueCol },
        cellP("{{contracts.fields.value}}"),
        P("{{/each}}"),
      ),
    ),
  );
})();

const fieldsTableVariants =
  P("{{#if hasVerdicts}}") +
  fieldsTableWithVerdict +
  P("{{#else}}") +
  fieldsTableNoVerdict +
  P("{{/if}}");

// ── Risks block ──────────────────────────────────────────────────────────────

const risksBlock =
  P("{{#if contracts.hasRisks}}") +
  styledP("Risks", "Heading3") +
  P("{{#each contracts.risks}}") +
  boldLeadP(
    "{{contracts.risks.issue}}  ·  {{contracts.risks.severity}}  ·  {{contracts.risks.verdict}}",
  ) +
  styledP("{{contracts.risks.rationale}}", "BodyText") +
  // The citation line is gated per risk. Inside the risks loop the condition
  // must use the BARE item-relative path ({{#if hasCitation}}): the loop
  // recursion assigns the risk item's own fields onto the evaluation context,
  // while the prefixed form (contracts.risks.hasCitation) would resolve
  // `contracts` to the contract item, whose `risks` is an array — undefined.
  P("{{#if hasCitation}}") +
  styledP("Citation: {{contracts.risks.citation}}", "Caption") +
  P("{{/if}}") +
  P("{{/each}}") +
  P("{{/if}}");

// ── Per-contract section ─────────────────────────────────────────────────────

// Document type / risk level render as separate block-level {{#if}} lines
// (block conditions see the loop item's context; inline conditions would not),
// so nothing dangles when the view has no document-type column or no verdicts.
const contractSection =
  P("{{#each contracts}}") +
  styledP("{{@index}}. {{contracts.name}}", "Heading2") +
  P("{{#if contracts.hasDocumentType}}") +
  styledP("Document type: {{contracts.documentType}}", "Caption") +
  P("{{/if}}") +
  P("{{#if contracts.hasRiskLevel}}") +
  styledP("Risk level: {{contracts.riskLevel}}", "Caption") +
  P("{{/if}}") +
  fieldsTableVariants +
  risksBlock +
  // The per-contract summary is AI-drafted; gate the heading AND value on
  // {{#if aiNarrative}} so a deterministic export leaves nothing behind.
  P("{{#if aiNarrative}}") +
  styledP("Summary", "Heading3") +
  styledP("{{contracts.summary}}", "BodyText") +
  P("{{/if}}") +
  P("{{/each}}");

// ── Annex — review matrix ────────────────────────────────────────────────────

const ANNEX_NAME_COL = 2706;
const ANNEX_SUMMARY_COL = TEXT_WIDTH - ANNEX_NAME_COL;

const annexTable = table(
  [ANNEX_NAME_COL, ANNEX_SUMMARY_COL],
  row(
    HEADER_TRPR,
    headerCell(ANNEX_NAME_COL, "Contract"),
    headerCell(ANNEX_SUMMARY_COL, "Review summary"),
  ),
  row(
    ROW_TRPR,
    cell(
      { width: ANNEX_NAME_COL, fill: LABEL_FILL },
      P("{{#each grid.rows}}"),
      cellP("{{grid.rows.name}}", LABEL_RPR),
    ),
    cell(
      { width: ANNEX_SUMMARY_COL },
      cellP("{{grid.rows.summary}}"),
      P("{{/each}}"),
    ),
  ),
);

const annexSection =
  styledP("Annex — Review matrix", "Heading1") +
  styledP(
    "A consolidated overview of every reviewed contract and its extracted columns.",
    "BodyText",
  ) +
  annexTable;

// ── Cover block (page 1, no separate cover page) ─────────────────────────────

const TITLE = "Due Diligence Report";

const coverBlock =
  styledP("Privileged & Confidential · Attorney Work Product", "Confidential") +
  styledP(TITLE, "Title") +
  styledP("{{workspace.name}} · {{generatedAt}}", "Subtitle") +
  RULE;

const bodyXml =
  coverBlock +
  execSummarySection +
  styledP("Contract Review", "Heading1") +
  contractSection +
  annexSection;

// ── Section properties (A4, header + footer references) ───────────────────────

const SECT_PR =
  "<w:sectPr>" +
  '<w:headerReference w:type="default" r:id="rId2"/>' +
  '<w:footerReference w:type="default" r:id="rId3"/>' +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"' +
  ' w:header="720" w:footer="720" w:gutter="0"/>' +
  "</w:sectPr>";

// ── styles.xml ───────────────────────────────────────────────────────────────

const paragraphStyle = (
  styleId: string,
  name: string,
  pPr: string,
  rPr: string,
): string =>
  `<w:style w:type="paragraph" w:styleId="${styleId}">` +
  `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  `${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}` +
  "</w:style>";

const STYLES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  "<w:docDefaults><w:rPrDefault><w:rPr>",
  '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>',
  '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>',
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/>',
  "</w:pPr></w:pPrDefault></w:docDefaults>",
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>',
  paragraphStyle("BodyText", "Body Text", '<w:spacing w:after="120"/>', ""),
  paragraphStyle(
    "Title",
    "Title",
    '<w:spacing w:before="240" w:after="60"/>',
    `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="52"/><w:szCs w:val="52"/>`,
  ),
  paragraphStyle(
    "Subtitle",
    "Subtitle",
    '<w:spacing w:after="80"/>',
    `<w:color w:val="${MID_GRAY}"/><w:sz w:val="24"/><w:szCs w:val="24"/>`,
  ),
  paragraphStyle(
    "Confidential",
    "Confidential",
    '<w:spacing w:after="80"/>',
    `<w:smallCaps/><w:spacing w:val="40"/><w:color w:val="${GRAY}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`,
  ),
  paragraphStyle(
    "Heading1",
    "heading 1",
    `<w:keepNext/><w:spacing w:before="360" w:after="160"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="${BORDER_GRAY}"/></w:pBdr><w:outlineLvl w:val="0"/>`,
    `<w:b/><w:color w:val="${NAVY}"/><w:sz w:val="28"/><w:szCs w:val="28"/>`,
  ),
  paragraphStyle(
    "Heading2",
    "heading 2",
    '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>',
    `<w:b/><w:color w:val="${NEAR_BLACK}"/><w:sz w:val="24"/><w:szCs w:val="24"/>`,
  ),
  paragraphStyle(
    "Heading3",
    "heading 3",
    '<w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/>',
    `<w:b/><w:color w:val="${NEAR_BLACK}"/><w:sz w:val="22"/><w:szCs w:val="22"/>`,
  ),
  paragraphStyle(
    "Caption",
    "caption",
    '<w:spacing w:before="0" w:after="40"/>',
    `<w:color w:val="${MID_GRAY}"/><w:sz w:val="19"/><w:szCs w:val="19"/>`,
  ),
  paragraphStyle(
    "HeaderText",
    "header",
    '<w:jc w:val="right"/><w:spacing w:after="0"/>',
    `<w:color w:val="${GRAY}"/><w:sz w:val="17"/><w:szCs w:val="17"/>`,
  ),
  paragraphStyle(
    "FooterText",
    "footer",
    '<w:jc w:val="center"/><w:spacing w:after="0"/>',
    `<w:color w:val="${GRAY}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`,
  ),
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr>${TBL_BORDERS}${TBL_CELL_MAR}</w:tblPr></w:style>`,
  "</w:styles>",
].join("");

// ── header / footer parts ────────────────────────────────────────────────────

const HEADER_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  styledP("{{workspace.name}}", "HeaderText"),
  "</w:hdr>",
].join("");

const pageField = (instruction: string): string =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;

const GRAY_SMALL_RPR = `<w:color w:val="${GRAY}"/><w:sz w:val="16"/><w:szCs w:val="16"/>`;

const FOOTER_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
  '<w:p><w:pPr><w:pStyle w:val="FooterText"/></w:pPr>',
  run("Page ", GRAY_SMALL_RPR),
  pageField("PAGE"),
  run(" of ", GRAY_SMALL_RPR),
  pageField("NUMPAGES"),
  "</w:p>",
  styledP("Privileged & Confidential", "FooterText"),
  "</w:ftr>",
].join("");

// ── Package assembly ─────────────────────────────────────────────────────────

const REL = {
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  styles:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
  header:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
  footer:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
} as const;

const CONTENT_TYPE = {
  styles:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  header:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
  footer:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
} as const;

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
      `<Override PartName="/word/styles.xml" ContentType="${CONTENT_TYPE.styles}"/>` +
      `<Override PartName="/word/header1.xml" ContentType="${CONTENT_TYPE.header}"/>` +
      `<Override PartName="/word/footer1.xml" ContentType="${CONTENT_TYPE.footer}"/>` +
      "</Types>",
  );

  zip
    .folder("_rels")
    ?.file(
      ".rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL.officeDocument}" Target="word/document.xml"/>` +
        "</Relationships>",
    );

  const word = zip.folder("word");
  word?.file(
    "document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<w:body>${bodyXml}${SECT_PR}</w:body></w:document>`,
  );
  word?.file("styles.xml", STYLES_XML);
  word?.file("header1.xml", HEADER_XML);
  word?.file("footer1.xml", FOOTER_XML);
  word
    ?.folder("_rels")
    ?.file(
      "document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL.styles}" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="${REL.header}" Target="header1.xml"/>` +
        `<Relationship Id="rId3" Type="${REL.footer}" Target="footer1.xml"/>` +
        "</Relationships>",
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
