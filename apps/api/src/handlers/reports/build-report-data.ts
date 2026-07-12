/**
 * View → report data builder.
 *
 * Walks a saved table view server-side (the same visible columns, filters and
 * sorts the user sees) and produces the stable, documented data object the
 * report template is filled with. The shape is the contract between view and
 * template; see {@link ReportData}.
 *
 * Derivation reuses the spreadsheet export's already-tested helpers
 * (`buildExportColumns` for column order + verdict↔ASK pairing,
 * `formatFieldContent` for display strings), so a report and a CSV of the same
 * view agree cell-for-cell.
 *
 * AI hygiene: NO entity/property UUIDs enter the data object. Contracts are
 * identified by 1-based `index`. `summary` (per contract) and `execSummary`
 * (top level) are intentionally left ABSENT so the template's `aiPrompt` fields
 * draft them at fill time; this builder never calls a model.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { JustificationContent, PropertyRole } from "@/api/db/schema";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import type { PositionSeverity } from "@/api/handlers/playbooks/position-facets";
import { isDocumentTypeClassifierShape } from "@/api/handlers/properties/create-schema";
import {
  buildExportColumns,
  formatFieldContent,
} from "@/api/handlers/views/table-export";
import type { SafeId } from "@/api/lib/branded-types";
// eslint-disable-next-line no-restricted-imports -- brands field ids returned by queryEntities (server-validated, workspace-scoped) to re-hydrate their justifications
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type { ViewLayout } from "@/api/lib/views-schema";

/** Report display locale. i18n of the default report is out of scope; the data
 *  object is language-neutral and values render with the en formatter. */
const REPORT_LOCALE = "en";

/** Postgres bound-parameter safety: chunk justification lookups so a report at
 *  the row ceiling cannot overflow a single `IN (...)`. */
const JUSTIFICATION_FIELD_ID_BATCH = 1000;

/** Verdict tiers that count as a finding (a red flag) on the report. */
const RISK_VERDICT_TIERS = new Set(["deviation", "missing"]);

/** Severity order for "worst finding wins" (index = rank; lower is worse). */
const SEVERITY_ORDER = ["blocker", "high", "medium", "low"] as const;

type TableLayout = Extract<ViewLayout, { type: "table" }>;

type ReportProperty = {
  id: string;
  name: string;
  content: PropertyContent;
  role: PropertyRole | null;
  tool: PropertyTool;
};

type ExportColumn = ReturnType<typeof buildExportColumns>[number];
type ReportPropertyColumn = Extract<ExportColumn, { type: "property" }>;

const isPropertyColumn = (
  column: ExportColumn,
): column is ReportPropertyColumn => column.type === "property";

export type ReportField = {
  label: string;
  value: string;
  /** Verdict tier when this column is a graded position, else "". */
  verdict: string;
  /** Severity of the graded position, else "". */
  severity: string;
};

export type ReportRisk = {
  severity: PositionSeverity;
  /** The graded position (ASK property) name. */
  issue: string;
  /** The verdict tier: "deviation" | "missing". */
  verdict: string;
  /** Model rationale from the verdict's playbook-verdict justification block. */
  rationale: string;
  /** First quoted citation text from the ASK field's justification, else "". */
  citation: string;
  /** True when {@link citation} is non-empty; gates the template's
   *  "Citation: …" line so a risk without a quoted source renders no dangling
   *  label. */
  hasCitation: boolean;
};

export type ReportContract = {
  /** 1-based identity; no UUIDs cross into the AI-visible object. */
  index: number;
  name: string;
  documentType: string;
  /** True when this contract has a non-empty document type; gates the inline
   *  "Document type: …" line so it never renders a dangling label. */
  hasDocumentType: boolean;
  /** Worst severity among this contract's findings, or "ok" when none. */
  riskLevel: PositionSeverity | "ok";
  /** Mirrors the top-level {@link ReportData.hasVerdicts}: a riskLevel is only
   *  meaningful when the view carries playbook verdicts, so this gates the
   *  "Risk level: …" line (a view without playbook has no verdicts and its
   *  "ok" riskLevel is noise). */
  hasRiskLevel: boolean;
  fields: ReportField[];
  risks: ReportRisk[];
  hasRisks: boolean;
  // `summary` is deliberately absent — the template's per-item aiPrompt field
  // drafts it at fill time.
};

export type ReportStats = {
  total: number;
  redFlags: number;
  bySeverity: { blocker: number; high: number; medium: number; low: number };
};

/** One column header of the review-matrix annex (one per visible property
 *  column, ASK/verdict paired the same way the per-contract field table pairs
 *  them). */
export type ReportGridColumn = { label: string };

/** One contract's value under a single review column. `value` folds the verdict
 *  tier in as a suffix, mirroring how the per-contract field table surfaces it. */
export type ReportGridCell = { label: string; value: string };

export type ReportGridRow = {
  name: string;
  cells: ReportGridCell[];
  /** Pre-joined "Label: value" text for the whole row. The DOCX row-repeat can
   *  clone a `w:tr` per row but not a `w:tc` per column (no cell-repeat in the
   *  grammar), so a true dynamic-column matrix is not renderable; the built-in
   *  annex renders this consolidated summary cell instead. `columns`/`cells`
   *  keep the faithful matrix data for callers that can consume it. */
  summary: string;
};

/** Docs × columns review matrix: the same visible columns and rows the builder
 *  already walks, reshaped as a grid for the annex. */
export type ReportGrid = {
  columns: ReportGridColumn[];
  rows: ReportGridRow[];
};

export type ReportData = {
  workspace: { name: string };
  generatedAt: string;
  stats: ReportStats;
  contracts: ReportContract[];
  grid: ReportGrid;
  /** True when any visible column is a graded (playbook-verdict) position. Gates
   *  the two variants of the per-contract field table (with vs. without the
   *  Verdict column) and the executive-summary findings breakdown: a view with
   *  no playbook renders the plain variants and no verdict/severity noise. */
  hasVerdicts: boolean;
  /** Drives the built-in template's `{{#if aiNarrative}}` gates: when false the
   *  executive-summary and per-contract summary paragraphs are removed entirely
   *  and no AI generator runs, so the export is fast and deterministic. */
  aiNarrative: boolean;
  // `execSummary` is deliberately absent — a top-level aiPrompt field drafts it
  // at fill time.
};

/** Join a row's cells into the annex summary cell text. */
const GRID_CELL_SEPARATOR = " · ";

/** Whether a row (contract) count exceeds the hard export cap. Exported as a
 *  pure predicate so both the enqueue count check and the build-time guard —
 *  and their tests — share one definition. */
export const isReportRowCountOverCap = (count: number): boolean =>
  count > LIMITS.reportExportMaxRows;

const worstSeverity = (
  severities: PositionSeverity[],
): PositionSeverity | "ok" => {
  let worst: PositionSeverity | "ok" = "ok";
  let worstRank: number = SEVERITY_ORDER.length;
  for (const severity of severities) {
    const rank = SEVERITY_ORDER.indexOf(severity);
    if (rank !== -1 && rank < worstRank) {
      worstRank = rank;
      worst = severity;
    }
  }
  return worst;
};

const severityByPropertyId = (
  properties: ReportProperty[],
): Map<string, PositionSeverity> => {
  const map = new Map<string, PositionSeverity>();
  for (const property of properties) {
    if (property.tool.type === "playbook-verdict") {
      map.set(property.id, property.tool.severity);
    }
  }
  return map;
};

/** The verdict's rationale (playbook-verdict block). */
const rationaleFromJustification = (
  content: JustificationContent | undefined,
): string => {
  if (!content) {
    return "";
  }
  for (const block of content.blocks) {
    if (block.kind === "playbook-verdict" && block.rationale.length > 0) {
      return block.rationale;
    }
  }
  return "";
};

/** First quoted citation text from an extraction's justification: a docx-folio
 *  cite carries the literal quoted source; a pdf-bates block's statement text is
 *  the quoted statement (bates is only a locator). */
const citationFromJustification = (
  content: JustificationContent | undefined,
): string => {
  if (!content) {
    return "";
  }
  for (const block of content.blocks) {
    if (block.kind === "docx-folio") {
      for (const statement of block.statements) {
        const cite = statement.citations.find((c) => c.text.length > 0);
        if (cite) {
          return cite.text;
        }
      }
    }
    if (block.kind === "pdf-bates") {
      const statement = block.statements.find((s) => s.text.length > 0);
      if (statement) {
        return statement.text;
      }
    }
  }
  return "";
};

type AssembleReportDataArgs = {
  entities: QueryEntityResult[];
  columns: ExportColumn[];
  properties: ReportProperty[];
  justificationByFieldId: Map<string, JustificationContent>;
  docTypePropertyId: string | null;
  workspaceName: string;
  now: Date;
  /** Include AI-drafted narrative sections; defaults to on. */
  aiNarrative?: boolean;
};

/**
 * Pure assembly of the report data object from already-fetched inputs. Kept
 * free of any DB/model dependency so the derivation (column order, verdict
 * pairing, risk mapping, stats) is exhaustively testable in isolation.
 */
export const assembleReportData = ({
  entities,
  columns,
  properties,
  justificationByFieldId,
  docTypePropertyId,
  workspaceName,
  now,
  aiNarrative = true,
}: AssembleReportDataArgs): ReportData => {
  const severities = severityByPropertyId(properties);
  const propertyColumns = columns.filter(isPropertyColumn);

  // A view carries verdicts when at least one visible column is a graded
  // position (ASK paired with a playbook-verdict property). Drives the template's
  // Verdict-column and findings-breakdown gates.
  const hasVerdicts = propertyColumns.some(
    (column) => column.verdictPropertyId !== undefined,
  );

  // The Document Type classifier renders as the per-contract caption line, not
  // as a field row (a field row would duplicate it and drag a dead verdict cell
  // along). The annex summary re-adds it as a "Type: …" prefix instead.
  const reportColumns = propertyColumns.filter(
    (column) => column.propertyId !== docTypePropertyId,
  );

  const bySeverity = { blocker: 0, high: 0, medium: 0, low: 0 };

  const contracts: ReportContract[] = entities.map((entity, entityIndex) => {
    const fieldByPropertyId = new Map(
      entity.fields.map((field) => [field.propertyId, field]),
    );

    const documentType = docTypePropertyId
      ? formatFieldContent(
          fieldByPropertyId.get(docTypePropertyId)?.content,
          REPORT_LOCALE,
        )
      : "";

    const fields: ReportField[] = [];
    const risks: ReportRisk[] = [];
    const contractSeverities: PositionSeverity[] = [];

    for (const column of reportColumns) {
      const askField = fieldByPropertyId.get(column.propertyId);
      const value = formatFieldContent(askField?.content, REPORT_LOCALE);

      const verdictField = column.verdictPropertyId
        ? fieldByPropertyId.get(column.verdictPropertyId)
        : undefined;
      const tier = formatFieldContent(verdictField?.content, REPORT_LOCALE);
      const severity = column.verdictPropertyId
        ? severities.get(column.verdictPropertyId)
        : undefined;

      fields.push({
        label: column.header,
        value,
        verdict: tier,
        severity: severity ?? "",
      });

      if (verdictField && RISK_VERDICT_TIERS.has(tier) && severity) {
        contractSeverities.push(severity);
        bySeverity[severity] += 1;
        const citation = askField
          ? citationFromJustification(justificationByFieldId.get(askField.id))
          : "";
        risks.push({
          severity,
          issue: column.header,
          verdict: tier,
          rationale: rationaleFromJustification(
            justificationByFieldId.get(verdictField.id),
          ),
          citation,
          hasCitation: citation.length > 0,
        });
      }
    }

    return {
      index: entityIndex + 1,
      name: entity.name ?? "Untitled",
      documentType,
      hasDocumentType: documentType.length > 0,
      riskLevel: worstSeverity(contractSeverities),
      // A riskLevel is only meaningful when the view grades positions; without
      // verdicts every contract is "ok", which is noise, so gate it on the view.
      hasRiskLevel: hasVerdicts,
      fields,
      risks,
      hasRisks: risks.length > 0,
    };
  });

  const redFlags =
    bySeverity.blocker + bySeverity.high + bySeverity.medium + bySeverity.low;

  return {
    workspace: { name: workspaceName },
    generatedAt: formatGeneratedAt(now),
    stats: { total: contracts.length, redFlags, bySeverity },
    contracts,
    grid: buildReviewGrid(reportColumns, contracts),
    hasVerdicts,
    aiNarrative,
  };
};

/** Reshape the visible columns + assembled contracts into the annex matrix. The
 *  cells reuse each contract's already-computed fields (same order as the
 *  columns), so the annex and the per-contract tables can never disagree. The
 *  summary cell prepends a "Type: …" segment when the contract has a document
 *  type: the classifier is excluded from the field columns (the per-contract
 *  caption owns it), and the annex has no caption, so the prefix keeps the
 *  information present there. */
const buildReviewGrid = (
  reportColumns: ReportPropertyColumn[],
  contracts: ReportContract[],
): ReportGrid => {
  const columns: ReportGridColumn[] = reportColumns.map((column) => ({
    label: column.header,
  }));
  const rows: ReportGridRow[] = contracts.map((contract) => {
    const cells: ReportGridCell[] = contract.fields.map((field) => ({
      label: field.label,
      value: field.verdict ? `${field.value} (${field.verdict})` : field.value,
    }));
    const segments = cells.map((cell) => `${cell.label}: ${cell.value}`);
    if (contract.hasDocumentType) {
      segments.unshift(`Type: ${contract.documentType}`);
    }
    return {
      name: contract.name,
      cells,
      summary: segments.join(GRID_CELL_SEPARATOR),
    };
  });
  return { columns, rows };
};

const generatedAtFormatter = new Intl.DateTimeFormat(REPORT_LOCALE, {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

const formatGeneratedAt = (now: Date): string =>
  generatedAtFormatter.format(now);

/** The workspace "Document Type" classifier property id, or null when absent. */
export const findDocTypePropertyId = (
  properties: ReportProperty[],
): string | null => {
  const roleMatch = properties.find(
    (property) =>
      property.role === "document-type-classifier" &&
      isDocumentTypeClassifierShape({
        content: property.content,
        tool: property.tool,
      }),
  );
  if (roleMatch) {
    return roleMatch.id;
  }
  const nameMatch = properties.find(
    (property) =>
      property.name.trim().toLowerCase() === "document type" &&
      isDocumentTypeClassifierShape({
        content: property.content,
        tool: property.tool,
      }),
  );
  return nameMatch?.id ?? null;
};

type BuildReportDataArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  currentUserId: SafeId<"user">;
  layout: TableLayout;
  workspaceName: string;
  now?: Date;
  /** Include AI-drafted narrative sections; defaults to on. */
  aiNarrative?: boolean;
};

/**
 * Fetch the view's rows, properties and justifications, then assemble the
 * report data. Exceeding {@link LIMITS.reportExportMaxRows} is a typed error
 * (fail fast, no truncated report). Returns a `Result` so the caller can map
 * the cap error to its own response.
 */
export const buildReportData = async ({
  safeDb,
  workspaceId,
  organizationId,
  currentUserId,
  layout,
  workspaceName,
  now = new Date(),
  aiNarrative = true,
}: BuildReportDataArgs) =>
  await Result.gen(async function* () {
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            name: true,
            content: true,
            role: true,
            tool: true,
          },
          orderBy: { createdAt: "asc" },
          limit: LIMITS.propertiesCount,
        }),
      ),
    );

    const columns = buildExportColumns(layout, properties);
    const propertyColumns = columns.filter(isPropertyColumn);

    // Verdict properties have no column of their own but their field values
    // (tier) and justifications are needed, so load them alongside the ASK ids.
    const loadedPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      loadedPropertyIds.add(column.propertyId);
      if (column.verdictPropertyId) {
        loadedPropertyIds.add(column.verdictPropertyId);
      }
    }
    const docTypePropertyId = findDocTypePropertyId(properties);
    if (docTypePropertyId) {
      loadedPropertyIds.add(docTypePropertyId);
    }
    const fieldIds: SafeId<"property">[] = [];
    for (const property of properties) {
      if (loadedPropertyIds.has(property.id)) {
        fieldIds.push(toSafeId<"property">(property.id));
      }
    }

    const queryResult = yield* Result.await(
      queryEntities({
        safeDb,
        workspaceId,
        currentUserId,
        currentOrganizationId: organizationId,
        filters: layout.filters,
        sorts: layout.sorts,
        // +1 so a view exactly one over the cap is detected, never truncated.
        limit: LIMITS.reportExportMaxRows + 1,
        fieldMode: "visible",
        fieldIds,
        excludedKinds: ["folder", "task"],
      }),
    );

    if (isReportRowCountOverCap(queryResult.entities.length)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `This view has more than ${LIMITS.reportExportMaxRows} rows; narrow the view's filters before exporting a report.`,
        }),
      );
    }

    // Justifications annotate the report: the verdict's rationale and the ASK
    // extraction's citation. Load both for every ASK/verdict column.
    const commentPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      if (column.verdictPropertyId) {
        commentPropertyIds.add(column.propertyId);
        commentPropertyIds.add(column.verdictPropertyId);
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
          for (
            let index = 0;
            index < commentFieldIds.length;
            index += JUSTIFICATION_FIELD_ID_BATCH
          ) {
            const batch = commentFieldIds.slice(
              index,
              index + JUSTIFICATION_FIELD_ID_BATCH,
            );
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop, react-doctor/async-await-in-loop -- sequential reads on one tx connection; the batch caps each `IN (...)` below the bound-parameter limit
            const batchRows = await tx.query.justifications.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                fieldId: { in: batch },
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

    return Result.ok(
      assembleReportData({
        entities: queryResult.entities,
        columns,
        properties,
        justificationByFieldId,
        docTypePropertyId,
        workspaceName,
        now,
        aiNarrative,
      }),
    );
  });
