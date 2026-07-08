import { Result } from "better-result";
import { t } from "elysia";
import JSZip from "jszip";

import type { JustificationContent } from "@/api/db/schema";
import type { FieldContent, PropertyTool } from "@/api/db/schema-validators";
import { env } from "@/api/env";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
// eslint-disable-next-line no-restricted-imports -- export boundary: brands field ids returned by queryEntities (server-validated, workspace-scoped) to re-hydrate their justifications from Postgres
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { contentDisposition } from "@/api/lib/content-disposition";
import { escapeCSV } from "@/api/lib/csv";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { extractFormattingLocale } from "@/api/lib/locale";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { ViewLayout } from "@/api/lib/views-schema";
import { parseViewLayout } from "@/api/lib/views-schema";

// Postgres caps bound parameters per statement; chunk the justification
// lookup so an export at the row ceiling cannot overflow a single `IN (...)`.
const JUSTIFICATION_FIELD_ID_BATCH = 1000;

// Author shown on every exported cell note. Brand copy keeps "stella"
// lowercase.
const EXPORT_COMMENT_AUTHOR = "stella";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

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
  tool: PropertyTool;
};

type ExportColumn =
  | {
      type: "property";
      id: string;
      propertyId: string;
      header: string;
      // A graded playbook position renders its ASK column merged with the
      // tier from this paired `playbook-verdict` property; the verdict never
      // gets its own column.
      verdictPropertyId?: string;
      // The property whose field justification annotates this cell as a note:
      // the verdict for a merged position, otherwise the AI extraction itself.
      commentPropertyId?: string;
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

// Absolute-URL context for turning a document cell into a folio deep link.
type ExportLinkContext = {
  baseUrl: string;
  workspaceId: string;
  viewId: string;
};

type BuildExportTableOptions = {
  link: ExportLinkContext;
  justificationByFieldId: Map<string, JustificationContent>;
};

type ExportCellStyle = "default" | CellFlagId;

type ExportTextCell = {
  type: "text";
  value: string;
  style: ExportCellStyle;
  // Absolute folio URL when the cell is a document file name.
  hyperlink?: string;
  // Rationale/citation note surfaced as an Excel cell comment.
  comment?: string;
};

type ExportNumberCell = {
  type: "number";
  value: number;
  displayValue: string;
  currency: string | null;
  style: ExportCellStyle;
  comment?: string;
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
  mcp: { type: "pending" },
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
  const verdictByAskPropertyId = new Map<string, ExportProperty>();
  const verdictPropertyIds = new Set<string>();
  for (const property of properties) {
    if (property.tool.type === "playbook-verdict") {
      verdictByAskPropertyId.set(property.tool.askPropertyId, property);
      verdictPropertyIds.add(property.id);
    }
  }

  const propertyColumns = properties
    .filter(
      (property) =>
        !hiddenIds.has(property.id) && !verdictPropertyIds.has(property.id),
    )
    .map((property) => {
      const column: Extract<ExportColumn, { type: "property" }> = {
        type: "property",
        id: property.id,
        propertyId: property.id,
        header: property.name,
      };

      const verdict = verdictByAskPropertyId.get(property.id);
      if (verdict) {
        column.verdictPropertyId = verdict.id;
        column.commentPropertyId = verdict.id;
      } else if (property.tool.type === "ai-model") {
        column.commentPropertyId = property.id;
      }

      return column;
    });
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

export const formatExportDate = (value: string, locale: string): string => {
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
  locale: string,
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
  locale: string,
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
  locale: string,
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

type ExportTextCellOptions = {
  hyperlink?: string | undefined;
  comment?: string | undefined;
};

const buildTextExportCell = (
  value: string,
  style: ExportCellStyle = "default",
  options: ExportTextCellOptions = {},
): ExportTextCell => {
  const cell: ExportTextCell = {
    type: "text",
    value: sanitizeSpreadsheetCell(value),
    style,
  };
  if (options.hyperlink) {
    cell.hyperlink = options.hyperlink;
  }
  if (options.comment) {
    cell.comment = sanitizeSpreadsheetCell(options.comment);
  }
  return cell;
};

const buildNumberExportCell = (
  value: number,
  displayValue: string,
  currency: string | null,
  style: ExportCellStyle = "default",
  comment?: string,
): ExportNumberCell => {
  const cell: ExportNumberCell = {
    type: "number",
    value,
    displayValue: sanitizeSpreadsheetCell(displayValue),
    currency,
    style,
  };
  if (comment) {
    cell.comment = sanitizeSpreadsheetCell(comment);
  }
  return cell;
};

// Folio deep link to the document behind a file cell. Mirrors the route the
// app itself navigates to when opening a file from a table row
// (`/workspaces/:workspaceId/:viewId/document?entity=&field=`). The target is
// always built from the configured app base URL, never from cell text.
const buildDocumentUrl = ({
  link,
  entityId,
  fieldId,
}: {
  link: ExportLinkContext;
  entityId: string;
  fieldId: string;
}): string =>
  `${link.baseUrl}/workspaces/${link.workspaceId}/${link.viewId}/document` +
  `?entity=${encodeURIComponent(entityId)}&field=${encodeURIComponent(fieldId)}`;

// Folds a graded position's extracted value and its verdict tier into one
// readable cell, e.g. `Net 30 (deviation)`. The tier is the verdict
// single-select value; the export is not label-localized, so that value is the
// stable label.
const mergeVerdictValue = (askValue: string, tier: string): string => {
  if (tier.length === 0) {
    return askValue;
  }
  if (askValue.length === 0) {
    return tier;
  }
  return `${askValue} (${tier})`;
};

const justificationToComment = (
  content: JustificationContent | undefined,
): string => {
  if (!content) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content.blocks) {
    if (block.kind === "playbook-verdict") {
      if (block.rationale.length > 0) {
        parts.push(block.rationale);
      }
      continue;
    }
    for (const statement of block.statements) {
      if (statement.text.length > 0) {
        parts.push(statement.text);
      }
    }
  }

  return parts.join("\n");
};

type BuildPropertyCellParams = {
  column: Extract<ExportColumn, { type: "property" }>;
  fieldByPropertyId: Map<string, QueryEntityResult["fields"][number]>;
  entityId: string;
  locale: string;
  style: ExportCellStyle;
  link: ExportLinkContext;
  justificationByFieldId: Map<string, JustificationContent>;
};

const buildPropertyCell = ({
  column,
  fieldByPropertyId,
  entityId,
  locale,
  style,
  link,
  justificationByFieldId,
}: BuildPropertyCellParams): ExportCell => {
  const field = fieldByPropertyId.get(column.propertyId);
  const content = field?.content;

  const commentField = column.commentPropertyId
    ? fieldByPropertyId.get(column.commentPropertyId)
    : undefined;
  const comment = commentField
    ? justificationToComment(justificationByFieldId.get(commentField.id))
    : "";
  const commentOption = comment.length > 0 ? comment : undefined;

  if (column.verdictPropertyId) {
    const tier = formatFieldContent(
      fieldByPropertyId.get(column.verdictPropertyId)?.content,
      locale,
    );
    const merged = mergeVerdictValue(formatFieldContent(content, locale), tier);
    return buildTextExportCell(merged, style, { comment: commentOption });
  }

  if (content?.type === "file" && field) {
    return buildTextExportCell(formatFieldContent(content, locale), style, {
      hyperlink: buildDocumentUrl({ link, entityId, fieldId: field.id }),
      comment: commentOption,
    });
  }

  if (content?.type === "int") {
    return buildNumberExportCell(
      content.value,
      formatFieldContent(content, locale),
      content.currency,
      style,
      commentOption,
    );
  }

  return buildTextExportCell(formatFieldContent(content, locale), style, {
    comment: commentOption,
  });
};

const buildMetadataExportCell = (
  column: Extract<ExportColumn, { type: "metadata" }>,
  entity: QueryEntityResult,
  locale: string,
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
  locale: string,
  options: BuildExportTableOptions,
): ExportTable => ({
  columns,
  rows: entities.map((entity) => {
    const fieldByPropertyId = new Map(
      entity.fields.map((field) => [field.propertyId, field]),
    );
    const metadataByPropertyId = new Map(
      entity.cellMetadata.map((entry) => [entry.propertyId, entry.metadata]),
    );

    return columns.map((column) => {
      if (column.type === "property") {
        return buildPropertyCell({
          column,
          fieldByPropertyId,
          entityId: entity.entityId,
          locale,
          style: getExportCellStyle(
            metadataByPropertyId.get(column.propertyId),
          ),
          link: options.link,
          justificationByFieldId: options.justificationByFieldId,
        });
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

type CellHyperlink = { ref: string; url: string; relId: string };
type CellComment = { ref: string; text: string; row: number; column: number };

const collectCellAnnotations = (
  columns: ExportColumn[],
  rows: ExportRow[],
): { hyperlinks: CellHyperlink[]; comments: CellComment[] } => {
  const hyperlinks: CellHyperlink[] = [];
  const comments: CellComment[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) {
      continue;
    }
    const excelRow = rowIndex + 2;
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const cell = row.at(columnIndex);
      if (!cell) {
        continue;
      }
      const ref = `${columnName(columnIndex)}${excelRow}`;
      if (cell.type === "text" && cell.hyperlink) {
        hyperlinks.push({
          ref,
          url: cell.hyperlink,
          relId: `rId${hyperlinks.length + 1}`,
        });
      }
      if (cell.comment) {
        comments.push({
          ref,
          text: cell.comment,
          row: excelRow - 1,
          column: columnIndex,
        });
      }
    }
  }

  return { hyperlinks, comments };
};

export const buildXlsxExport = async ({
  columns,
  rows,
  worksheetName,
}: ExportTable & { worksheetName?: string }): Promise<ArrayBuffer> => {
  const zip = new JSZip();
  const styleRegistry = buildStyleRegistry(rows);
  const { hyperlinks, comments } = collectCellAnnotations(columns, rows);
  const hasComments = comments.length > 0;
  const commentsRelId = `rId${hyperlinks.length + 1}`;
  const vmlRelId = `rId${hyperlinks.length + 2}`;

  zip.file("[Content_Types].xml", buildContentTypesXml(hasComments));
  zip.file("_rels/.rels", rootRelsXml);
  zip.file("xl/workbook.xml", buildWorkbookXml(worksheetName ?? "Table"));
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml);
  zip.file("xl/styles.xml", buildStylesXml(styleRegistry));
  zip.file(
    "xl/worksheets/sheet1.xml",
    buildSheetXml({
      columns,
      rows,
      styleRegistry,
      hyperlinks,
      vmlRelId: hasComments ? vmlRelId : null,
    }),
  );

  if (hyperlinks.length > 0 || hasComments) {
    zip.file(
      "xl/worksheets/_rels/sheet1.xml.rels",
      buildWorksheetRelsXml({
        hyperlinks,
        hasComments,
        commentsRelId,
        vmlRelId,
      }),
    );
  }
  if (hasComments) {
    zip.file("xl/comments1.xml", buildCommentsXml(comments));
    zip.file("xl/drawings/vmlDrawing1.vml", buildVmlDrawingXml(comments));
  }

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
            tool: true,
          },
          orderBy: { createdAt: "asc" },
          limit: LIMITS.propertiesCount,
        }),
      ),
    );

    const columns = buildExportColumns(layout, properties);
    const propertyColumns = columns.filter(
      (column) => column.type === "property",
    );
    // Verdict properties have no column of their own, but their field values
    // are merged into the paired ASK cell, so they must still be fetched.
    const loadedPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      loadedPropertyIds.add(column.propertyId);
      if (column.verdictPropertyId) {
        loadedPropertyIds.add(column.verdictPropertyId);
      }
    }
    const fieldIds = properties
      .filter((property) => loadedPropertyIds.has(property.id))
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
        limit: LIMITS.exportRowLimit,
        fieldMode: "visible",
        fieldIds,
        excludedKinds: ["folder", "task"],
      }),
    );

    // Each annotated cell takes its note from one property's field
    // justification: the verdict's rationale for a merged position, otherwise
    // the AI extraction's own reasoning/citations.
    const commentPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      if (column.commentPropertyId) {
        commentPropertyIds.add(column.commentPropertyId);
      }
    }
    const commentFieldIds: SafeId<"field">[] = [];
    if (commentPropertyIds.size > 0) {
      for (const entity of queryResult.entities) {
        for (const field of entity.fields) {
          if (commentPropertyIds.has(field.propertyId)) {
            commentFieldIds.push(toSafeId<"field">(field.id));
          }
        }
      }
    }

    const justificationByFieldId = new Map<string, JustificationContent>();
    if (commentFieldIds.length > 0) {
      const justificationRows = yield* Result.await(
        safeDb(async (tx) => {
          const rows: { fieldId: string; content: JustificationContent }[] = [];
          for (const fieldIdBatch of chunkArray(
            commentFieldIds,
            JUSTIFICATION_FIELD_ID_BATCH,
          )) {
            // oxlint-disable-next-line no-await-in-loop -- sequential reads on the same transaction connection (one in-flight query per tx); the batch caps each `IN (...)` below the bound-parameter limit
            const batchRows = await tx.query.justifications.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                fieldId: { in: fieldIdBatch },
              },
              columns: { fieldId: true, content: true },
              limit: JUSTIFICATION_FIELD_ID_BATCH,
            });
            rows.push(...batchRows);
          }
          return rows;
        }),
      );
      for (const row of justificationRows) {
        justificationByFieldId.set(row.fieldId, row.content);
      }
    }

    const locale = extractFormattingLocale(request);
    const link: ExportLinkContext = {
      baseUrl: env.FRONTEND_URL.replace(/\/$/u, ""),
      workspaceId,
      viewId,
    };
    const table = buildExportTable(columns, queryResult.entities, locale, {
      link,
      justificationByFieldId,
    });
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

type BuildInlineStringCellXmlOptions = {
  value: string;
  rowIndex: number;
  columnIndex: number;
  styleId: number;
};

const buildInlineStringCellXml = ({
  value,
  rowIndex,
  columnIndex,
  styleId,
}: BuildInlineStringCellXmlOptions) => {
  const preserveWhitespace = /^\s|\s$/u.test(value)
    ? ' xml:space="preserve"'
    : "";
  return `<c r="${columnName(columnIndex)}${rowIndex}" s="${styleId}" t="inlineStr"><is><t${preserveWhitespace}>${escapeXml(
    value,
  )}</t></is></c>`;
};

type BuildNumberCellXmlOptions = {
  value: number;
  rowIndex: number;
  columnIndex: number;
  styleId: number;
};

const buildNumberCellXml = ({
  value,
  rowIndex,
  columnIndex,
  styleId,
}: BuildNumberCellXmlOptions): string =>
  `<c r="${columnName(columnIndex)}${rowIndex}" s="${styleId}"><v>${value}</v></c>`;

const buildHeaderRowXml = (columns: ExportColumn[]): string => {
  const cells = columns
    .map((column, columnIndex) =>
      buildInlineStringCellXml({
        value: sanitizeSpreadsheetHeader(column.header),
        rowIndex: 1,
        columnIndex,
        styleId: HEADER_STYLE_ID,
      }),
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
    return buildNumberCellXml({
      value: cell.value,
      rowIndex,
      columnIndex,
      styleId: numberCellStyleId(cell, styleRegistry),
    });
  }

  return buildInlineStringCellXml({
    value: cell.value,
    rowIndex,
    columnIndex,
    styleId: textCellStyleId(cell.style),
  });
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
  hyperlinks: CellHyperlink[];
  vmlRelId: string | null;
};

const buildSheetXml = ({
  columns,
  rows,
  styleRegistry,
  hyperlinks,
  vmlRelId,
}: BuildSheetXmlParams): string => {
  const autoFilterRef =
    columns.length > 0 ? `A1:${columnName(columns.length - 1)}1` : "";
  const autoFilterXml =
    autoFilterRef.length > 0 ? `<autoFilter ref="${autoFilterRef}"/>` : "";
  const sheetRowsXml = `${buildHeaderRowXml(columns)}${buildBodyRowsXml(rows, styleRegistry)}`;
  const hyperlinksXml =
    hyperlinks.length > 0
      ? `<hyperlinks>${hyperlinks
          .map(
            (hyperlink) =>
              `<hyperlink ref="${hyperlink.ref}" r:id="${hyperlink.relId}"/>`,
          )
          .join("")}</hyperlinks>`
      : "";
  const legacyDrawingXml = vmlRelId
    ? `<legacyDrawing r:id="${vmlRelId}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
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
  ${hyperlinksXml}
  ${legacyDrawingXml}
</worksheet>`;
};

const RELATIONSHIP_TYPE_BASE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const buildContentTypesXml = (hasComments: boolean): string => {
  const commentDefaults = hasComments
    ? '\n  <Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>'
    : "";
  const commentOverride = hasComments
    ? '\n  <Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>'
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${commentDefaults}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${commentOverride}
</Types>`;
};

type BuildWorksheetRelsParams = {
  hyperlinks: CellHyperlink[];
  hasComments: boolean;
  commentsRelId: string;
  vmlRelId: string;
};

// Document cells link to their folio deep link via per-cell external
// relationships. These are the only `TargetMode="External"` parts the export
// emits, and every target is built from the configured app base URL, never
// from user-supplied cell text.
const buildWorksheetRelsXml = ({
  hyperlinks,
  hasComments,
  commentsRelId,
  vmlRelId,
}: BuildWorksheetRelsParams): string => {
  const hyperlinkRels = hyperlinks
    .map(
      (hyperlink) =>
        `<Relationship Id="${hyperlink.relId}" Type="${RELATIONSHIP_TYPE_BASE}/hyperlink" Target="${escapeXml(
          hyperlink.url,
        )}" TargetMode="External"/>`,
    )
    .join("");
  const commentRels = hasComments
    ? `<Relationship Id="${commentsRelId}" Type="${RELATIONSHIP_TYPE_BASE}/comments" Target="../comments1.xml"/><Relationship Id="${vmlRelId}" Type="${RELATIONSHIP_TYPE_BASE}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hyperlinkRels}${commentRels}</Relationships>`;
};

const buildCommentsXml = (comments: CellComment[]): string => {
  const commentXml = comments
    .map(
      (comment) =>
        `<comment ref="${comment.ref}" authorId="0"><text><r><t xml:space="preserve">${escapeXml(
          comment.text,
        )}</t></r></text></comment>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>${escapeXml(
    EXPORT_COMMENT_AUTHOR,
  )}</author></authors><commentList>${commentXml}</commentList></comments>`;
};

// Excel renders cell notes from a legacy VML drawing: one hidden text box per
// comment, anchored to its cell.
const buildVmlDrawingXml = (comments: CellComment[]): string => {
  const shapes = comments
    .map((comment, index) => {
      const shapeId = `_x0000_s${1025 + index}`;
      const anchor = `${comment.column + 1}, 15, ${comment.row}, 2, ${
        comment.column + 3
      }, 15, ${comment.row + 4}, 4`;
      return `<v:shape id="${shapeId}" type="#_x0000_t202" style="position:absolute;margin-left:60pt;margin-top:1.5pt;width:144pt;height:75.75pt;z-index:${
        index + 1
      };visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${anchor}</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${comment.row}</x:Row><x:Column>${comment.column}</x:Column></x:ClientData></v:shape>`;
    })
    .join("");

  return `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
};

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
