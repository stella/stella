import { Result } from "better-result";
import { t } from "elysia";
import JSZip from "jszip";

import type { FieldContent } from "@/api/db/schema-validators";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { contentDisposition } from "@/api/lib/content-disposition";
import { escapeCSV } from "@/api/lib/csv";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { extractLangFromRequest } from "@/api/lib/locale";
import type { SupportedLang } from "@/api/lib/locale";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { ViewLayout } from "@/api/lib/views-schema";
import { parseViewLayout } from "@/api/lib/views-schema";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const SPREADSHEET_EXPORT_LIMITS = {
  /**
   * Excel's documented maximum cell text length is 32,767
   * characters. Enforcing it before XML generation prevents corrupt
   * workbooks and avoids letting one extracted field create a very
   * large XML node.
   */
  cellTextChars: 32_767,
  /**
   * Column headers come from user-defined property names. 255 keeps
   * headers usable in Excel filters while preventing oversized
   * header XML and pathological column-width calculation.
   */
  headerTextChars: 255,
  /**
   * Excel worksheet names are limited to 31 characters. The current
   * export names the worksheet after the matter, truncated to this
   * limit before XML generation.
   */
  worksheetNameChars: 31,
  /**
   * The endpoint applies this row cap before building CSV/XLSX so a
   * single export cannot produce an unbounded workbook.
   */
  rows: LIMITS.exportRowLimit,
} as const;

const TRUNCATION_MARKER = "\n[truncated]";

const METADATA_COLUMNS = [
  { id: "_created-by", header: "Author" },
  { id: "_updated-at", header: "Last updated" },
  { id: "_version", header: "Version" },
] as const;

const CELL_FLAG_IDS = [
  "needs-review",
  "important",
  "follow-up",
  "contradiction",
  "verified",
] as const;

type CellFlagId = (typeof CELL_FLAG_IDS)[number];

type ExportProperty = {
  id: string;
  name: string;
};

type ExportColumn =
  | {
      type: "property";
      id: string;
      propertyId: string;
      header: string;
    }
  | {
      type: "metadata";
      id: (typeof METADATA_COLUMNS)[number]["id"];
      header: string;
    };

export type ExportTable = {
  columns: ExportColumn[];
  rows: ExportRow[];
};

type ExportCellStyle = "default" | CellFlagId;

type ExportTextCell = {
  type: "text";
  value: string;
  style: ExportCellStyle;
};

type ExportNumberCell = {
  type: "number";
  value: number;
  displayValue: string;
  currency: string | null;
  style: ExportCellStyle;
};

type ExportCell = ExportTextCell | ExportNumberCell;

type ExportRow = ExportCell[];

const isCellFlagId = (value: string): value is CellFlagId =>
  CELL_FLAG_IDS.some((flagId) => flagId === value);

const stripInvalidXmlTextChars = (value: string): string =>
  value.replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "");

const truncateText = (value: string, maxChars: number): string => {
  const chars = Array.from(value);
  if (chars.length <= maxChars) {
    return value;
  }

  const prefixLength = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${chars.slice(0, prefixLength).join("")}${TRUNCATION_MARKER}`;
};

export const sanitizeSpreadsheetText = (
  value: string,
  maxChars: number,
): string => truncateText(stripInvalidXmlTextChars(value), maxChars);

const sanitizeSpreadsheetHeader = (value: string): string =>
  sanitizeSpreadsheetText(value, SPREADSHEET_EXPORT_LIMITS.headerTextChars);

const sanitizeSpreadsheetCell = (value: string): string =>
  sanitizeSpreadsheetText(value, SPREADSHEET_EXPORT_LIMITS.cellTextChars);

export const sanitizeWorksheetName = (value: string): string => {
  const withoutForbiddenCharacters = value
    .replaceAll("[", " ")
    .replaceAll("]", " ")
    .replaceAll(":", " ")
    .replaceAll("*", " ")
    .replaceAll("?", " ")
    .replaceAll("/", " ")
    .replaceAll("\\", " ")
    .trim();
  const cleaned = Array.from(
    stripInvalidXmlTextChars(withoutForbiddenCharacters),
  )
    .slice(0, SPREADSHEET_EXPORT_LIMITS.worksheetNameChars)
    .join("");

  return cleaned.length > 0 ? cleaned : "Table";
};

const config = {
  permissions: { workspace: ["read"] },
  params: workspaceParams({ viewId: tSafeId("workspaceView") }),
  query: t.Object({
    format: t.Union([t.Literal("csv"), t.Literal("xlsx")]),
  }),
} satisfies HandlerConfig;

export const buildExportColumns = (
  layout: Extract<ViewLayout, { type: "table" }>,
  properties: ExportProperty[],
): ExportColumn[] => {
  const hiddenIds = new Set(layout.hiddenProperties);
  const propertyColumns = properties
    .filter((property) => !hiddenIds.has(property.id))
    .map((property) => ({
      type: "property" as const,
      id: property.id,
      propertyId: property.id,
      header: property.name,
    }));
  const metadataColumns = METADATA_COLUMNS.filter(
    (column) => !hiddenIds.has(column.id),
  ).map((column) => ({
    type: "metadata" as const,
    id: column.id,
    header: column.header,
  }));
  const defaultColumns: ExportColumn[] = [
    ...propertyColumns,
    ...metadataColumns,
  ];

  if (layout.columnOrder.length === 0) {
    return defaultColumns;
  }

  const byId = new Map(defaultColumns.map((column) => [column.id, column]));
  const ordered: ExportColumn[] = [];
  for (const columnId of layout.columnOrder) {
    const column = byId.get(columnId);
    if (!column) {
      continue;
    }
    ordered.push(column);
    byId.delete(columnId);
  }

  return [...ordered, ...byId.values()];
};

export const formatExportDate = (
  value: string,
  locale: SupportedLang,
): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
};

const formatExportNumber = (
  value: number,
  currency: string | null,
  locale: SupportedLang,
): string => {
  if (!currency) {
    return new Intl.NumberFormat(locale).format(value);
  }

  const formattedCurrency = Result.try(() =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
    }).format(value),
  );
  if (!Result.isError(formattedCurrency)) {
    return formattedCurrency.value;
  }

  return `${new Intl.NumberFormat(locale).format(value)} ${currency}`;
};

export const formatFieldContent = (
  content: FieldContent | undefined,
  locale: SupportedLang,
): string => {
  if (!content) {
    return "";
  }

  switch (content.type) {
    case "text":
      return content.value;
    case "file":
      return content.fileName;
    case "single-select":
      return content.value ?? "";
    case "multi-select":
      return content.value.join(", ");
    case "date":
      return content.value ? formatExportDate(content.value, locale) : "";
    case "int":
      return formatExportNumber(content.value, content.currency, locale);
    case "clip":
      return content.url;
    case "error":
      return "Error";
    case "pending":
      return "";
    case "unsupported":
      return "Unsupported";
    default:
      return "";
  }
};

const formatMetadataColumn = (
  column: Extract<ExportColumn, { type: "metadata" }>,
  entity: QueryEntityResult,
  locale: SupportedLang,
): string => {
  switch (column.id) {
    case "_created-by":
      return entity.createdBy ?? "";
    case "_updated-at":
      return formatExportDate(entity.updatedAt ?? entity.createdAt, locale);
    case "_version":
      return String(entity.version);
    default:
      return "";
  }
};

const buildTextExportCell = (
  value: string,
  style: ExportCellStyle = "default",
): ExportTextCell => ({
  type: "text",
  value: sanitizeSpreadsheetCell(value),
  style,
});

const buildNumberExportCell = (
  value: number,
  displayValue: string,
  currency: string | null,
  style: ExportCellStyle = "default",
): ExportNumberCell => ({
  type: "number",
  value,
  displayValue: sanitizeSpreadsheetCell(displayValue),
  currency,
  style,
});

const buildPropertyExportCell = (
  content: FieldContent | undefined,
  locale: SupportedLang,
  style: ExportCellStyle,
): ExportCell => {
  if (content?.type !== "int") {
    return buildTextExportCell(formatFieldContent(content, locale), style);
  }

  return buildNumberExportCell(
    content.value,
    formatFieldContent(content, locale),
    content.currency,
    style,
  );
};

const buildMetadataExportCell = (
  column: Extract<ExportColumn, { type: "metadata" }>,
  entity: QueryEntityResult,
  locale: SupportedLang,
): ExportCell => {
  if (column.id === "_version") {
    return buildNumberExportCell(entity.version, String(entity.version), null);
  }

  return buildTextExportCell(formatMetadataColumn(column, entity, locale));
};

const getExportCellStyle = (
  metadata: QueryEntityResult["cellMetadata"][number]["metadata"] | undefined,
): ExportCellStyle => {
  if (!metadata) {
    return "default";
  }

  const firstKnownFlag = metadata.manualFlags.find((flag) =>
    isCellFlagId(flag),
  );
  if (!firstKnownFlag) {
    return "default";
  }

  return firstKnownFlag;
};

export const buildExportTable = (
  columns: ExportColumn[],
  entities: QueryEntityResult[],
  locale: SupportedLang,
): ExportTable => ({
  columns,
  rows: entities.map((entity) => {
    const fieldByPropertyId = new Map(
      entity.fields.map((field) => [field.propertyId, field.content]),
    );
    const metadataByPropertyId = new Map(
      entity.cellMetadata.map((entry) => [entry.propertyId, entry.metadata]),
    );

    return columns.map((column) => {
      if (column.type === "property") {
        const metadata = metadataByPropertyId.get(column.propertyId);
        return buildPropertyExportCell(
          fieldByPropertyId.get(column.propertyId),
          locale,
          getExportCellStyle(metadata),
        );
      }

      return buildMetadataExportCell(column, entity, locale);
    });
  }),
});

export const buildCsvExport = ({ columns, rows }: ExportTable): string => {
  const lines = [
    columns
      .map((column) => escapeCSV(sanitizeSpreadsheetHeader(column.header)))
      .join(","),
  ];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCSV(cellDisplayValue(cell))).join(","));
  }
  return lines.join("\n");
};

export const buildXlsxExport = async ({
  columns,
  rows,
  worksheetName,
}: ExportTable & { worksheetName?: string }): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  const styleRegistry = buildStyleRegistry(rows);

  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("_rels/.rels", rootRelsXml);
  zip.file("xl/workbook.xml", buildWorkbookXml(worksheetName ?? "Table"));
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml);
  zip.file("xl/styles.xml", buildStylesXml(styleRegistry));
  zip.file(
    "xl/worksheets/sheet1.xml",
    buildSheetXml({ columns, rows, styleRegistry }),
  );

  return await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  });
};

const exportTableView = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    user,
    session,
    request,
    params: { viewId },
    query,
  }) {
    const view = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaceViews.findFirst({
          where: {
            id: { eq: viewId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            name: true,
            layout: true,
          },
        }),
      ),
    );

    if (!view) {
      return Result.err(
        new HandlerError({ status: 404, message: "View not found" }),
      );
    }

    const layout = parseViewLayout(view.layout);
    if (layout.type !== "table") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Only table views can be exported",
        }),
      );
    }

    const workspace = yield* Result.await(
      safeDb((tx) =>
        tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { name: true },
        }),
      ),
    );
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
          },
          orderBy: { createdAt: "asc" },
        }),
      ),
    );

    const columns = buildExportColumns(layout, properties);
    const visiblePropertyColumnIds = new Set(
      columns
        .filter((column) => column.type === "property")
        .map((column) => column.propertyId),
    );
    const fieldIds = properties
      .filter((property) => visiblePropertyColumnIds.has(property.id))
      .map((property) => property.id);

    // Export the same persisted table shape the user sees: visible
    // columns in saved order, saved filters/sorts, and visible field
    // values only. Purely visual client state such as column pixel
    // widths or content wrapping does not affect cell values.
    const queryResult = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId: user.id,
        currentOrganizationId: session.activeOrganizationId,
        filters: layout.filters,
        sorts: layout.sorts,
        offset: 0,
        limit: LIMITS.exportRowLimit,
        fieldMode: "visible",
        fieldIds,
        excludedKinds: ["folder", "task"],
        includeTotalCount: false,
      }),
    );

    const lang = extractLangFromRequest(request);
    const table = buildExportTable(columns, queryResult.entities, lang);
    const exportName = workspace?.name ?? view.name;
    const body =
      query.format === "csv"
        ? buildCsvExport(table)
        : await buildXlsxExport({ ...table, worksheetName: exportName });
    const filename = sanitizeFilename(`${exportName}.${query.format}`);

    return Result.ok(
      new Response(body, {
        headers: {
          "Content-Disposition": contentDisposition(filename),
          "Content-Type":
            query.format === "csv" ? "text/csv; charset=utf-8" : XLSX_MIME_TYPE,
        },
      }),
    );
  },
);

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const columnName = (index: number): string => {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCodePoint(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const BODY_STYLE_ID = 1;
const HEADER_STYLE_ID = 2;
const CELL_FLAG_STYLE_IDS = {
  "needs-review": 3,
  important: 4,
  "follow-up": 5,
  contradiction: 6,
  verified: 7,
} as const satisfies Record<CellFlagId, number>;
const CELL_FLAG_FILL_IDS = {
  "needs-review": 3,
  important: 4,
  "follow-up": 5,
  contradiction: 6,
  verified: 7,
} as const satisfies Record<CellFlagId, number>;
const MIN_COLUMN_WIDTH = 12;
const MAX_COLUMN_WIDTH = 42;
const BUILT_IN_INTEGER_NUMBER_FORMAT_ID = 3;
const FIRST_CUSTOM_NUMBER_FORMAT_ID = 164;

const textCellStyleId = (style: ExportCellStyle): number => {
  if (style === "default") {
    return BODY_STYLE_ID;
  }

  return CELL_FLAG_STYLE_IDS[style];
};

const cellFillId = (style: ExportCellStyle): number => {
  if (style === "default") {
    return 0;
  }

  return CELL_FLAG_FILL_IDS[style];
};

const cellDisplayValue = (cell: ExportCell): string => {
  if (cell.type === "text") {
    return cell.value;
  }

  return cell.displayValue;
};

const calculateColumnWidths = (
  columns: ExportColumn[],
  rows: ExportRow[],
): number[] => {
  const longestByColumn = columns.map(
    (column) => sanitizeSpreadsheetHeader(column.header).length,
  );

  for (const row of rows) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const cell = row.at(columnIndex);
      longestByColumn[columnIndex] = Math.max(
        longestByColumn[columnIndex] ?? 0,
        cell ? cellDisplayValue(cell).length : 0,
      );
    }
  }

  return longestByColumn.map((longestContent) => {
    const paddedWidth = Math.ceil(longestContent * 1.1) + 2;
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, paddedWidth));
  });
};

const buildColumnsXml = (
  columns: ExportColumn[],
  rows: ExportRow[],
): string => {
  if (columns.length === 0) {
    return "";
  }

  const columnWidths = calculateColumnWidths(columns, rows);
  const columnXml = columnWidths
    .map((width, index) => {
      const oneBasedColumnIndex = index + 1;
      return `<col min="${oneBasedColumnIndex}" max="${oneBasedColumnIndex}" width="${width}" customWidth="1"/>`;
    })
    .join("");

  return `<cols>${columnXml}</cols>`;
};

const buildInlineStringCellXml = (
  value: string,
  rowIndex: number,
  columnIndex: number,
  styleId: number,
) => {
  const preserveWhitespace = /^\s|\s$/u.test(value)
    ? ' xml:space="preserve"'
    : "";
  return `<c r="${columnName(columnIndex)}${rowIndex}" s="${styleId}" t="inlineStr"><is><t${preserveWhitespace}>${escapeXml(
    value,
  )}</t></is></c>`;
};

const buildNumberCellXml = (
  value: number,
  rowIndex: number,
  columnIndex: number,
  styleId: number,
): string =>
  `<c r="${columnName(columnIndex)}${rowIndex}" s="${styleId}"><v>${value}</v></c>`;

const buildHeaderRowXml = (columns: ExportColumn[]): string => {
  const cells = columns
    .map((column, columnIndex) =>
      buildInlineStringCellXml(
        sanitizeSpreadsheetHeader(column.header),
        1,
        columnIndex,
        HEADER_STYLE_ID,
      ),
    )
    .join("");

  return `<row r="1" ht="22" customHeight="1">${cells}</row>`;
};

const buildCellXml = (
  cell: ExportCell,
  rowIndex: number,
  columnIndex: number,
  styleRegistry: StyleRegistry,
): string => {
  if (cell.type === "number") {
    return buildNumberCellXml(
      cell.value,
      rowIndex,
      columnIndex,
      numberCellStyleId(cell, styleRegistry),
    );
  }

  return buildInlineStringCellXml(
    cell.value,
    rowIndex,
    columnIndex,
    textCellStyleId(cell.style),
  );
};

const buildBodyRowsXml = (
  rows: ExportRow[],
  styleRegistry: StyleRegistry,
): string =>
  rows
    .map((row, rowIndex) => {
      const oneBasedRowIndex = rowIndex + 2;
      const cells = row
        .map((cell, columnIndex) =>
          buildCellXml(cell, oneBasedRowIndex, columnIndex, styleRegistry),
        )
        .join("");
      return `<row r="${oneBasedRowIndex}" ht="34" customHeight="1">${cells}</row>`;
    })
    .join("");

type BuildSheetXmlParams = {
  columns: ExportColumn[];
  rows: ExportRow[];
  styleRegistry: StyleRegistry;
};

const buildSheetXml = ({
  columns,
  rows,
  styleRegistry,
}: BuildSheetXmlParams): string => {
  const autoFilterRef =
    columns.length > 0 ? `A1:${columnName(columns.length - 1)}1` : "";
  const autoFilterXml =
    autoFilterRef.length > 0 ? `<autoFilter ref="${autoFilterRef}"/>` : "";
  const sheetRowsXml = `${buildHeaderRowXml(columns)}${buildBodyRowsXml(rows, styleRegistry)}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
      <selection pane="bottomLeft"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${buildColumnsXml(columns, rows)}
  <sheetData>${sheetRowsXml}</sheetData>
  ${autoFilterXml}
</worksheet>`;
};

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const buildWorkbookXml = (
  worksheetName: string,
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sanitizeWorksheetName(worksheetName))}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

type NumberStyleIds = Record<ExportCellStyle, number>;

type CustomNumberFormat = {
  id: number;
  formatCode: string;
};

type StyleRegistry = {
  numberStyleIds: NumberStyleIds;
  currencyStyleIds: Map<string, NumberStyleIds>;
  customNumberFormats: CustomNumberFormat[];
  numericCellXfs: string[];
};

const CURRENCY_FORMAT_LABELS: Record<string, string> = {
  CHF: "CHF",
  CZK: "K\u010d",
  EUR: "\u20ac",
  GBP: "\u00a3",
  PLN: "z\u0142",
  USD: "$",
};

const excelNumberFormatLiteral = (value: string): string =>
  value.replaceAll('"', '""');

const currencyFormatCode = (currency: string): string => {
  const normalizedCurrency = currency.toUpperCase();
  const label =
    CURRENCY_FORMAT_LABELS[normalizedCurrency] ?? normalizedCurrency;

  return `"${excelNumberFormatLiteral(label)}"#,##0`;
};

const buildNumericCellXf = (
  style: ExportCellStyle,
  numFmtId: number,
): string => {
  const fillId = cellFillId(style);
  const applyFill = style === "default" ? "" : ' applyFill="1"';

  return `<xf numFmtId="${numFmtId}" fontId="0" fillId="${fillId}" borderId="1" xfId="0" applyNumberFormat="1"${applyFill} applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`;
};

const buildStyleRegistry = (rows: ExportRow[]): StyleRegistry => {
  const numericCellXfs: string[] = [];
  let nextStyleId = BASE_CELL_XFS.length;

  const addNumericStyle = (
    style: ExportCellStyle,
    numFmtId: number,
  ): number => {
    const styleId = nextStyleId;
    nextStyleId += 1;
    numericCellXfs.push(buildNumericCellXf(style, numFmtId));
    return styleId;
  };

  const addNumericStyleSet = (numFmtId: number): NumberStyleIds => ({
    default: addNumericStyle("default", numFmtId),
    "needs-review": addNumericStyle("needs-review", numFmtId),
    important: addNumericStyle("important", numFmtId),
    "follow-up": addNumericStyle("follow-up", numFmtId),
    contradiction: addNumericStyle("contradiction", numFmtId),
    verified: addNumericStyle("verified", numFmtId),
  });

  const numberStyleIds = addNumericStyleSet(BUILT_IN_INTEGER_NUMBER_FORMAT_ID);
  const currencies = [
    ...new Set(
      rows.flatMap((row) =>
        row.flatMap((cell) =>
          cell.type === "number" && cell.currency ? [cell.currency] : [],
        ),
      ),
    ),
  ].sort();
  const currencyStyleIds = new Map<string, NumberStyleIds>();
  const customNumberFormats: CustomNumberFormat[] = [];
  let nextNumberFormatId = FIRST_CUSTOM_NUMBER_FORMAT_ID;

  for (const currency of currencies) {
    const numFmtId = nextNumberFormatId;
    nextNumberFormatId += 1;
    customNumberFormats.push({
      id: numFmtId,
      formatCode: currencyFormatCode(currency),
    });
    currencyStyleIds.set(currency, addNumericStyleSet(numFmtId));
  }

  return {
    numberStyleIds,
    currencyStyleIds,
    customNumberFormats,
    numericCellXfs,
  };
};

const numberCellStyleId = (
  cell: ExportNumberCell,
  styleRegistry: StyleRegistry,
): number => {
  if (cell.currency) {
    return (
      styleRegistry.currencyStyleIds.get(cell.currency)?.[cell.style] ??
      styleRegistry.numberStyleIds[cell.style]
    );
  }

  return styleRegistry.numberStyleIds[cell.style];
};

const BASE_CELL_XFS = [
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>',
] as const;

const buildStylesXml = ({
  customNumberFormats,
  numericCellXfs,
}: StyleRegistry): string => {
  const customNumberFormatsXml =
    customNumberFormats.length > 0
      ? `  <numFmts count="${customNumberFormats.length}">
    ${customNumberFormats
      .map(
        ({ id, formatCode }) =>
          `<numFmt numFmtId="${id}" formatCode="${escapeXml(formatCode)}"/>`,
      )
      .join("\n    ")}
  </numFmts>
`
      : "";
  const cellXfs = [...BASE_CELL_XFS, ...numericCellXfs];

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${customNumberFormatsXml}  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Aptos"/></font>
    <font><b/><sz val="11"/><color rgb="FF111827"/><name val="Aptos"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECF3FE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF4EEFE"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFDECEC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE3F8EF"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border/>
    <border>
      <left style="thin"><color rgb="FFD1D5DB"/></left>
      <right style="thin"><color rgb="FFD1D5DB"/></right>
      <top style="thin"><color rgb="FFD1D5DB"/></top>
      <bottom style="thin"><color rgb="FFD1D5DB"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${cellXfs.length}">
    ${cellXfs.join("\n    ")}
  </cellXfs>
</styleSheet>`;
};

export default exportTableView;
