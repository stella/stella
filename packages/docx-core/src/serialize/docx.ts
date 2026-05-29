import JSZip from "jszip";

import type { BorderSpec } from "../model/colors";
import type {
  BlockContent,
  Document,
  Paragraph,
  ParagraphContent,
  Run,
  RunContent,
  SectionProperties,
  Style,
  Table,
  TextFormatting,
} from "../model/document";
import type { ListLevel, NumberingDefinitions } from "../model/lists";
import type { StyleDefinitions } from "../model/styles";
import { attr, escapeXml } from "./xml";

// We always ship a default page-numbering footer so generated
// legal documents have visible pagination out of the box. The
// reference id is fixed so callers don't need to thread it through
// section properties.
const DEFAULT_FOOTER_REL_ID = "rId10";
const DEFAULT_FOOTER_PART_NAME = "footer1.xml";

type FooterLabels = { page: string; of: string };

// Per-locale labels for the page-number footer. Falls back to
// English when the requested locale is missing — better to ship a
// readable English label than to leave an empty string.
const FOOTER_LABEL_FALLBACK: FooterLabels = { page: "Page", of: "of" };

const FOOTER_LABELS: Record<string, FooterLabels> = {
  en: FOOTER_LABEL_FALLBACK,
  cs: { page: "Strana", of: "z" },
  sk: { page: "Strana", of: "z" },
  de: { page: "Seite", of: "von" },
  fr: { page: "Page", of: "sur" },
  es: { page: "Página", of: "de" },
  it: { page: "Pagina", of: "di" },
  pl: { page: "Strona", of: "z" },
  pt: { page: "Página", of: "de" },
  nl: { page: "Pagina", of: "van" },
  hu: { page: "Oldal", of: "/" },
};

const resolveFooterLabels = (language: string | undefined): FooterLabels => {
  if (!language) {
    return FOOTER_LABEL_FALLBACK;
  }
  // Match `cs-CZ` → `cs`; locale tags downstream are normalised
  // case-insensitively.
  const primary = language.toLowerCase().split(/[-_]/u)[0] ?? "";
  return FOOTER_LABELS[primary] ?? FOOTER_LABEL_FALLBACK;
};

const buildFooterXml = (language: string | undefined): string => {
  const { page, of } = resolveFooterLabels(language);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:p>" +
    '<w:pPr><w:pStyle w:val="Footer"/><w:jc w:val="center"/></w:pPr>' +
    `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(page)} </w:t></w:r>` +
    '<w:fldSimple w:instr="PAGE   \\* MERGEFORMAT"><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>' +
    `<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> ${escapeXml(of)} </w:t></w:r>` +
    '<w:fldSimple w:instr="NUMPAGES   \\* MERGEFORMAT"><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>' +
    "</w:p>" +
    "</w:ftr>"
  );
};

const contentTypesXml = (hasNumbering: boolean): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    hasNumbering
      ? '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
      : "",
    `<Override PartName="/word/${DEFAULT_FOOTER_PART_NAME}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`,
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const documentRelsXml = (hasNumbering: boolean): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    hasNumbering
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
      : "",
    `<Relationship Id="${DEFAULT_FOOTER_REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="${DEFAULT_FOOTER_PART_NAME}"/>`,
    "</Relationships>",
  ].join("");

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>stella</Application>" +
  "</Properties>";

export type SerializeDocumentOptions = {
  /** BCP-47 language tag (e.g. "en", "cs", "cs-CZ"); used for footer labels. */
  language?: string;
};

export const serializeDocumentToDocx = async (
  document: Document,
  options: SerializeDocumentOptions = {},
): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  const hasNumbering = hasNumberingDefinitions(document.package.numbering);
  zip.file("[Content_Types].xml", contentTypesXml(hasNumbering));
  zip.folder("_rels")?.file(".rels", ROOT_RELS_XML);
  zip.folder("docProps")?.file("app.xml", APP_XML);
  zip.folder("docProps")?.file("core.xml", serializeCoreProperties(document));

  const word = zip.folder("word");
  word?.file("document.xml", serializeDocumentXml(document));
  word?.file("styles.xml", serializeStyles(document.package.styles));
  if (hasNumbering) {
    word?.file("numbering.xml", serializeNumbering(document.package.numbering));
  }
  word?.file(DEFAULT_FOOTER_PART_NAME, buildFooterXml(options.language));
  word
    ?.folder("_rels")
    ?.file("document.xml.rels", documentRelsXml(hasNumbering));

  return await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
};

const hasNumberingDefinitions = (
  numbering: NumberingDefinitions | undefined,
): numbering is NumberingDefinitions =>
  (numbering?.abstractNums.length ?? 0) > 0 ||
  (numbering?.nums.length ?? 0) > 0;

const serializeDocumentXml = (document: Document): string => {
  const body = document.package.document;
  const blocks = body.content.map(serializeBlock).join("");
  const sectionProperties = serializeSectionProperties(
    body.finalSectionProperties ?? {},
  );

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${blocks}${sectionProperties}</w:body>` +
    "</w:document>"
  );
};

const serializeBlock = (block: BlockContent): string => {
  switch (block.type) {
    case "paragraph":
      return serializeParagraph(block);
    case "table":
      return serializeTable(block);
    case "blockSdt":
      return "";
    default:
      block satisfies never;
      return "";
  }
};

const serializeParagraph = (paragraph: Paragraph): string => {
  const pPr = serializeParagraphProperties(paragraph);
  const content = paragraph.content.map(serializeParagraphContent).join("");
  return `<w:p>${pPr}${content}</w:p>`;
};

const serializeParagraphProperties = (paragraph: Paragraph): string => {
  const formatting = paragraph.formatting;
  if (!formatting && !paragraph.sectionProperties) {
    return "";
  }

  const parts: string[] = [];
  if (formatting?.styleId) {
    parts.push(`<w:pStyle w:val="${escapeXml(formatting.styleId)}"/>`);
  }
  if (formatting?.numPr?.numId !== undefined) {
    parts.push(
      "<w:numPr>" +
        `<w:ilvl w:val="${formatting.numPr.ilvl}"/>` +
        `<w:numId w:val="${formatting.numPr.numId}"/>` +
        "</w:numPr>",
    );
  }
  if (formatting?.alignment) {
    parts.push(`<w:jc w:val="${formatting.alignment}"/>`);
  }
  if (
    formatting?.spaceBefore !== undefined ||
    formatting?.spaceAfter !== undefined ||
    formatting?.lineSpacing !== undefined
  ) {
    parts.push(
      `<w:spacing${attr("w:before", formatting.spaceBefore)}${attr(
        "w:after",
        formatting.spaceAfter,
      )}${attr("w:line", formatting.lineSpacing)}${attr(
        "w:lineRule",
        formatting.lineSpacingRule,
      )}/>`,
    );
  }
  if (
    formatting?.indentLeft !== undefined ||
    formatting?.indentRight !== undefined ||
    formatting?.indentFirstLine !== undefined
  ) {
    parts.push(
      `<w:ind${attr("w:left", formatting.indentLeft)}${attr(
        "w:right",
        formatting.indentRight,
      )}${attr(
        formatting.hangingIndent ? "w:hanging" : "w:firstLine",
        formatting.indentFirstLine,
      )}/>`,
    );
  }
  if (formatting?.keepNext) {
    parts.push("<w:keepNext/>");
  }
  if (formatting?.keepLines) {
    parts.push("<w:keepLines/>");
  }
  if (formatting?.pageBreakBefore) {
    parts.push("<w:pageBreakBefore/>");
  }
  if (paragraph.sectionProperties) {
    parts.push(serializeSectionProperties(paragraph.sectionProperties));
  }

  return `<w:pPr>${parts.join("")}</w:pPr>`;
};

const serializeParagraphContent = (content: ParagraphContent): string => {
  switch (content.type) {
    case "run":
      return serializeRun(content);
    case "hyperlink":
    case "bookmarkStart":
    case "bookmarkEnd":
    case "simpleField":
    case "complexField":
    case "inlineSdt":
    case "commentRangeStart":
    case "commentRangeEnd":
    case "commentReference":
    case "insertion":
    case "deletion":
    case "moveFrom":
    case "moveTo":
    case "moveFromRangeStart":
    case "moveFromRangeEnd":
    case "moveToRangeStart":
    case "moveToRangeEnd":
    case "mathEquation":
      return "";
    default:
      content satisfies never;
      return "";
  }
};

const serializeRun = (run: Run): string => {
  const rPr = serializeRunProperties(run.formatting);
  const content = run.content.map(serializeRunContent).join("");
  return `<w:r>${rPr}${content}</w:r>`;
};

const serializeRunProperties = (
  formatting: TextFormatting | undefined,
): string => {
  if (!formatting) {
    return "";
  }

  const parts: string[] = [];
  if (formatting.styleId) {
    parts.push(`<w:rStyle w:val="${escapeXml(formatting.styleId)}"/>`);
  }
  if (formatting.bold) {
    parts.push("<w:b/>");
  }
  if (formatting.italic) {
    parts.push("<w:i/>");
  }
  if (formatting.allCaps) {
    parts.push("<w:caps/>");
  }
  if (formatting.smallCaps) {
    parts.push("<w:smallCaps/>");
  }
  if (formatting.highlight) {
    parts.push(`<w:highlight w:val="${formatting.highlight}"/>`);
  }
  if (formatting.fontSize !== undefined) {
    parts.push(`<w:sz w:val="${formatting.fontSize}"/>`);
  }
  if (formatting.fontFamily) {
    parts.push(
      `<w:rFonts${attr("w:ascii", formatting.fontFamily.ascii)}${attr(
        "w:hAnsi",
        formatting.fontFamily.hAnsi,
      )}${attr("w:cs", formatting.fontFamily.cs)}/>`,
    );
  }
  return parts.length > 0 ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
};

const serializeRunContent = (content: RunContent): string => {
  switch (content.type) {
    case "text":
      return `<w:t${
        content.preserveSpace ? ' xml:space="preserve"' : ""
      }>${escapeXml(content.text)}</w:t>`;
    case "tab":
      return "<w:tab/>";
    case "break":
      return `<w:br${attr("w:type", content.breakType)}/>`;
    case "symbol":
      return `<w:sym w:font="${escapeXml(content.font)}" w:char="${escapeXml(
        content.char,
      )}"/>`;
    case "footnoteRef":
      return `<w:footnoteReference w:id="${content.id}"/>`;
    case "endnoteRef":
      return `<w:endnoteReference w:id="${content.id}"/>`;
    case "fieldChar":
    case "instrText":
    case "softHyphen":
    case "noBreakHyphen":
    case "drawing":
    case "shape":
      return "";
    default:
      content satisfies never;
      return "";
  }
};

const serializeTable = (table: Table): string => {
  const columnCount = Math.max(0, ...table.rows.map((row) => row.cells.length));
  const gridWidth =
    columnCount > 0 ? Math.max(1, Math.floor(9000 / columnCount)) : 9000;
  const grid =
    columnCount > 0
      ? `<w:tblGrid>${Array.from(
          { length: columnCount },
          () => `<w:gridCol w:w="${gridWidth}"/>`,
        ).join("")}</w:tblGrid>`
      : "<w:tblGrid/>";
  // Borderless tables (e.g. side-by-side signature blocks) opt out
  // by setting `formatting.borders` to a record where each side's
  // style is "none". Anything else falls back to the default light
  // grey rule — matches how the prior implementation always shipped
  // bordered tables.
  const tableBorderXml = renderTableBorders(table);
  const cellBorderXml = renderCellBorders(table);
  const rows = table.rows
    .map(
      (row) =>
        `<w:tr>${row.cells
          .map(
            (cell) =>
              `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:tcBorders>${cellBorderXml}</w:tcBorders></w:tcPr>${cell.content
                .map(serializeBlock)
                .join("")}</w:tc>`,
          )
          .join("")}</w:tr>`,
    )
    .join("");

  return [
    "<w:tbl>",
    '<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>',
    tableBorderXml,
    "</w:tblBorders></w:tblPr>",
    grid,
    rows,
    "</w:tbl>",
  ].join("");
};

const renderTableBorders = (table: Table): string => {
  const borders = table.formatting?.borders;
  if (!borders) {
    return defaultBorderXml();
  }
  return [
    borderEdgeXml("w:top", borders.top),
    borderEdgeXml("w:left", borders.left),
    borderEdgeXml("w:bottom", borders.bottom),
    borderEdgeXml("w:right", borders.right),
    borderEdgeXml("w:insideH", borders.insideH),
    borderEdgeXml("w:insideV", borders.insideV),
  ].join("");
};

const renderCellBorders = (table: Table): string => {
  const borders = table.formatting?.borders;
  if (!borders) {
    return defaultBorderXml();
  }
  // Cells inherit per-edge from the table-level setting; "inside"
  // borders don't apply to a single cell so we drop them.
  return [
    borderEdgeXml("w:top", borders.top),
    borderEdgeXml("w:left", borders.left),
    borderEdgeXml("w:bottom", borders.bottom),
    borderEdgeXml("w:right", borders.right),
  ].join("");
};

const borderEdgeXml = (tag: string, spec: BorderSpec | undefined): string => {
  if (!spec) {
    return `<${tag} w:val="nil"/>`;
  }
  if (spec.style === "none" || spec.style === "nil") {
    return `<${tag} w:val="nil"/>`;
  }
  const sz = spec.size ?? 4;
  const color = spec.color?.rgb ?? "CCCCCC";
  return `<${tag} w:val="${spec.style}" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
};

const defaultBorderXml = (): string =>
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>';

const serializeSectionProperties = (properties: SectionProperties): string =>
  "<w:sectPr>" +
  `<w:footerReference w:type="default" r:id="${DEFAULT_FOOTER_REL_ID}"/>` +
  `<w:pgSz${attr("w:w", properties.pageWidth)}${attr(
    "w:h",
    properties.pageHeight,
  )}${attr(
    "w:orient",
    properties.orientation === "landscape" ? "landscape" : undefined,
  )}/>` +
  `<w:pgMar${attr("w:top", properties.marginTop)}${attr(
    "w:right",
    properties.marginRight,
  )}${attr("w:bottom", properties.marginBottom)}${attr(
    "w:left",
    properties.marginLeft,
  )}${attr("w:header", properties.headerDistance)}${attr(
    "w:footer",
    properties.footerDistance,
  )}${attr("w:gutter", properties.gutter ?? 0)}/>` +
  "</w:sectPr>";

const serializeStyles = (styles: StyleDefinitions | undefined): string => {
  const styleDefinitions = styles ?? { styles: [] };
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    serializeDocDefaults(styleDefinitions),
    styleDefinitions.styles.map(serializeStyle).join(""),
    "</w:styles>",
  ].join("");
};

const serializeDocDefaults = (styles: StyleDefinitions): string => {
  const rPr = serializeRunProperties(styles.docDefaults?.rPr);
  const pPrParts: string[] = [];
  const pPr = styles.docDefaults?.pPr;
  if (pPr?.spaceAfter !== undefined || pPr?.lineSpacing !== undefined) {
    pPrParts.push(
      `<w:spacing${attr("w:after", pPr.spaceAfter)}${attr(
        "w:line",
        pPr.lineSpacing,
      )}/>`,
    );
  }
  return `<w:docDefaults><w:rPrDefault>${rPr}</w:rPrDefault><w:pPrDefault><w:pPr>${pPrParts.join(
    "",
  )}</w:pPr></w:pPrDefault></w:docDefaults>`;
};

const serializeStyle = (style: Style): string => {
  const pPr = style.pPr
    ? serializeParagraphProperties({
        type: "paragraph",
        formatting: style.pPr,
        content: [],
      }).replace(/^<w:pPr>|<\/w:pPr>$/gu, "")
    : "";
  const rPr = serializeRunProperties(style.rPr);
  return [
    `<w:style w:type="${style.type}" w:styleId="${escapeXml(style.styleId)}"${
      style.default ? ' w:default="1"' : ""
    }>`,
    `<w:name w:val="${escapeXml(style.name ?? style.styleId)}"/>`,
    style.basedOn ? `<w:basedOn w:val="${escapeXml(style.basedOn)}"/>` : "",
    style.next ? `<w:next w:val="${escapeXml(style.next)}"/>` : "",
    style.qFormat ? "<w:qFormat/>" : "",
    pPr ? `<w:pPr>${pPr}</w:pPr>` : "",
    rPr,
    "</w:style>",
  ].join("");
};

const serializeNumbering = (
  numbering: NumberingDefinitions | undefined,
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    (numbering?.abstractNums ?? [])
      .map((abstractNum) =>
        [
          `<w:abstractNum w:abstractNumId="${abstractNum.abstractNumId}">`,
          `<w:nsid w:val="${abstractNumberingNsid(
            abstractNum.abstractNumId,
          )}"/>`,
          abstractNum.multiLevelType
            ? `<w:multiLevelType w:val="${abstractNum.multiLevelType}"/>`
            : "",
          abstractNum.levels.map(serializeNumberingLevel).join(""),
          "</w:abstractNum>",
        ].join(""),
      )
      .join(""),
    (numbering?.nums ?? [])
      .map(
        (num) =>
          `<w:num w:numId="${num.numId}"><w:abstractNumId w:val="${num.abstractNumId}"/></w:num>`,
      )
      .join(""),
    "</w:numbering>",
  ].join("");

const serializeNumberingLevel = (level: ListLevel): string =>
  [
    `<w:lvl w:ilvl="${level.ilvl}">`,
    `<w:start w:val="${level.start ?? 1}"/>`,
    `<w:numFmt w:val="${level.numFmt}"/>`,
    `<w:lvlText w:val="${escapeXml(level.lvlText)}"/>`,
    `<w:lvlJc w:val="${level.lvlJc ?? "left"}"/>`,
    level.suffix ? `<w:suff w:val="${level.suffix}"/>` : "",
    level.isLgl ? "<w:isLgl/>" : "",
    level.pPr
      ? serializeParagraphProperties({
          type: "paragraph",
          formatting: level.pPr,
          content: [],
        })
      : "",
    serializeRunProperties(level.rPr),
    "</w:lvl>",
  ].join("");

const abstractNumberingNsid = (abstractNumId: number): string =>
  abstractNumId.toString(16).toUpperCase().padStart(8, "0").slice(-8);

const serializeCoreProperties = (document: Document): string => {
  const properties = document.package.properties;
  const now = new Date().toISOString();
  const title = properties?.title ?? "";
  const creator = properties?.creator ?? "Stella";
  const created = properties?.created?.toISOString() ?? now;
  const modified = properties?.modified?.toISOString() ?? now;

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>${escapeXml(creator)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
};
