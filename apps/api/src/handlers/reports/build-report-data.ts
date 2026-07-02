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

import type { SafeDb } from "@/api/db";
import type { JustificationContent } from "@/api/db/schema";
import type { PropertyTool } from "@/api/db/schema-validators";
import type { QueryEntityResult } from "@/api/handlers/entities/query-entities";
import { queryEntities } from "@/api/handlers/entities/query-entities";
import type { PositionSeverity } from "@/api/handlers/playbooks/position-facets";
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

type ReportProperty = { id: string; name: string; tool: PropertyTool };

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
};

export type ReportContract = {
  /** 1-based identity; no UUIDs cross into the AI-visible object. */
  index: number;
  name: string;
  documentType: string;
  /** Worst severity among this contract's findings, or "ok" when none. */
  riskLevel: PositionSeverity | "ok";
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

export type ReportData = {
  workspace: { name: string };
  generatedAt: string;
  stats: ReportStats;
  contracts: ReportContract[];
  // `execSummary` is deliberately absent — a top-level aiPrompt field drafts it
  // at fill time.
};

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
}: AssembleReportDataArgs): ReportData => {
  const severities = severityByPropertyId(properties);
  const propertyColumns = columns.filter(isPropertyColumn);

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

    for (const column of propertyColumns) {
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
        risks.push({
          severity,
          issue: column.header,
          verdict: tier,
          rationale: rationaleFromJustification(
            justificationByFieldId.get(verdictField.id),
          ),
          citation: askField
            ? citationFromJustification(justificationByFieldId.get(askField.id))
            : "",
        });
      }
    }

    return {
      index: entityIndex + 1,
      name: entity.name ?? "Untitled",
      documentType,
      riskLevel: worstSeverity(contractSeverities),
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
  };
};

const formatGeneratedAt = (now: Date): string =>
  new Intl.DateTimeFormat(REPORT_LOCALE, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(now);

/** The workspace "Document Type" classifier property id (single-select AI
 *  column named "document type"), or null when the workspace has none. Matched
 *  by name to mirror `resolveDocTypeClassifier`. */
const findDocTypePropertyId = (properties: ReportProperty[]): string | null => {
  const match = properties.find(
    (property) =>
      property.name.trim().toLowerCase() === "document type" &&
      property.tool.type === "ai-model",
  );
  return match?.id ?? null;
};

type BuildReportDataArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  currentUserId: SafeId<"user">;
  layout: TableLayout;
  workspaceName: string;
  now?: Date;
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
}: BuildReportDataArgs) =>
  await Result.gen(async function* () {
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: { id: true, name: true, tool: true },
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
    const fieldIds = properties
      .filter((property) => loadedPropertyIds.has(property.id))
      .map((property) => toSafeId<"property">(property.id));

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
        includeTotalCount: false,
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
            // oxlint-disable-next-line no-await-in-loop -- sequential reads on one tx connection; the batch caps each `IN (...)` below the bound-parameter limit
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
      }),
    );
  });
