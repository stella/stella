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

import { panic, Result } from "better-result";
import { and, desc, eq, inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import type { JustificationContent, PropertyRole } from "@/api/db/schema";
import {
  documentReviewFindings,
  documentReviewRuns,
  entities as entitiesTable,
} from "@/api/db/schema";
import type { PropertyContent, PropertyTool } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
// eslint-disable-next-line no-restricted-imports -- brands field/entity ids returned by queryEntities (server-validated, workspace-scoped) to re-hydrate their justifications and review decisions
import { toSafeId } from "@/api/lib/branded-types";
import { compareByLocale } from "@/api/lib/collation";
import type { DocumentReviewDecision } from "@/api/lib/document-review/run-contract";
import type { QueryEntityResult } from "@/api/lib/entities/query-entities";
import { queryEntities } from "@/api/lib/entities/query-entities";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { isDocumentTypeClassifierShape } from "@/api/lib/properties/create-schema";
import { excludedEntityKindsForView } from "@/api/lib/views";
import type { ViewLayout } from "@/api/lib/views-schema";
import { buildExportColumns } from "@/api/lib/views/export-columns";
import { formatFieldContent } from "@/api/lib/views/export-format";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";

import type {
  GradedPosition,
  ReportCitation,
  ReportFinding,
  ReportLinks,
} from "./report-findings";
import {
  citationsFromJustification,
  compareFindings,
  hasNegotiationText,
  idealTextFromTiers,
  negotiationFromPosition,
  quotableCitationText,
  reportCitationKey,
  reviewDecisionKey,
  RISK_VERDICT_TIERS,
  verdictRationaleFromJustification,
  worstSeverity,
} from "./report-findings";

export type {
  ReportCitation,
  ReportCitationLink,
  ReportFinding,
  ReportFindingReview,
  ReportLinks,
  ReportMatchedRef,
  ReportNegotiation,
} from "./report-findings";
export { reportCitationKey, reviewDecisionKey } from "./report-findings";

/** Report display locale. i18n of the default report is out of scope; the data
 *  object is language-neutral and values render with the en formatter. */
const REPORT_LOCALE = "en";

/** Postgres bound-parameter safety: chunk justification lookups so a report at
 *  the row ceiling cannot overflow a single `IN (...)`. */
const JUSTIFICATION_FIELD_ID_BATCH = 1000;

type TableLayout = Extract<ViewLayout, { type: "table" }>;

type ReportProperty = {
  id: string;
  name: string;
  content: PropertyContent;
  role: PropertyRole | null;
  tool: PropertyTool;
  /** The playbook position this column was materialized from (its stable
   *  `sourceId`), or null for a hand-made column. Keys the position lookup and
   *  the document-review decision ledger. */
  playbookSourceId: string | null;
};

/** A justification row: `id` feeds the link index only. */
export type ReportJustification = {
  id: string;
  content: JustificationContent;
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
export type ReportGridColumn = {
  label: string;
  /** `graded` when the column is an ASK/verdict pair, regardless of whether
   *  any row holds a verdict yet. */
  kind: "field" | "graded";
};

/** One contract's value under a single review column. `verdict`/`severity`
 *  are "" for a column that is not a graded position, so a renderer can tell a
 *  graded cell apart without parsing the value. */
export type ReportGridCell = {
  label: string;
  value: string;
  verdict: string;
  severity: string;
};

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

/** Contracts sharing one document type, with their findings and roll-up.
 *  `documentType` is the raw classifier value ("" when unclassified; the
 *  renderer owns the "Unclassified" label). */
export type ReportGroup = {
  documentType: string;
  contracts: ReportContract[];
  findings: ReportFinding[];
  stats: ReportStats;
};

/** Reviewer-state roll-up across the whole report. A verdict cell is one
 *  (contract, graded column) pair holding a verdict value. */
export type ReportReviewStats = {
  openFindings: number;
  acceptedFindings: number;
  dismissedFindings: number;
  lockedCells: number;
  unlockedVerdictCells: number;
};

export type ReportData = {
  workspace: { name: string };
  generatedAt: string;
  stats: ReportStats;
  contracts: ReportContract[];
  /** Every finding, blocker → low then contract order. */
  findings: ReportFinding[];
  /** Contracts grouped by document type, worst group (most red flags) first. */
  groups: ReportGroup[];
  review: ReportReviewStats;
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

const emptyStats = (total: number): ReportStats => ({
  total,
  redFlags: 0,
  bySeverity: { blocker: 0, high: 0, medium: 0, low: 0 },
});

const countFinding = (stats: ReportStats, finding: ReportFinding): void => {
  stats.bySeverity[finding.severity] += 1;
  stats.redFlags += 1;
};

/** Project a finding onto the per-contract risk line, so the two views of one
 *  red flag can never disagree. */
const riskFromFinding = (finding: ReportFinding): ReportRisk => {
  const citation = quotableCitationText(finding.citations);
  return {
    severity: finding.severity,
    issue: finding.issue,
    verdict: finding.verdict,
    rationale: finding.rationale,
    citation,
    hasCitation: citation.length > 0,
  };
};

const compareDocumentType = compareByLocale(REPORT_LOCALE);

/** Groups ordered by red-flag count (desc), then document type (asc). */
const compareGroups = (a: ReportGroup, b: ReportGroup): number =>
  b.stats.redFlags - a.stats.redFlags ||
  compareDocumentType(a.documentType, b.documentType);

const buildGroups = (
  contracts: ReportContract[],
  findings: ReportFinding[],
): ReportGroup[] => {
  const byType = new Map<string, ReportGroup>();
  for (const contract of contracts) {
    const group = byType.get(contract.documentType);
    if (group) {
      group.contracts.push(contract);
      group.stats.total += 1;
      continue;
    }
    byType.set(contract.documentType, {
      documentType: contract.documentType,
      contracts: [contract],
      findings: [],
      stats: emptyStats(1),
    });
  }
  // `findings` is already in report order, so each group's slice inherits it.
  for (const finding of findings) {
    const group = byType.get(finding.documentType);
    if (!group) {
      continue;
    }
    group.findings.push(finding);
    countFinding(group.stats, finding);
  }
  return [...byType.values()].sort(compareGroups);
};

type VerdictPropertyInfo = {
  severity: PositionSeverity;
  idealText: string;
  playbookSourceId: string | null;
};

const verdictInfoByPropertyId = (
  properties: ReportProperty[],
): Map<string, VerdictPropertyInfo> => {
  const map = new Map<string, VerdictPropertyInfo>();
  for (const property of properties) {
    if (property.tool.type === "playbook-verdict") {
      map.set(property.id, {
        severity: property.tool.severity,
        // The verdict's tier snapshot, not the live definition: it is what the
        // verdict was graded against.
        idealText: idealTextFromTiers(property.tool.tiers),
        playbookSourceId: property.playbookSourceId,
      });
    }
  }
  return map;
};

type AssembleReportDataArgs = {
  entities: QueryEntityResult[];
  columns: ExportColumn[];
  properties: ReportProperty[];
  justificationByFieldId: Map<string, ReportJustification>;
  /** Graded playbook positions by `sourceId`; enriches findings with guidance
   *  and negotiation text. A verdict column whose position is absent yields
   *  empty strings. Defaults to empty. */
  positionBySourceId?: Map<string, GradedPosition>;
  /** Document-review decisions keyed by {@link reviewDecisionKey}; a missing
   *  key reads as "none". Defaults to empty. */
  reviewDecisionByKey?: Map<string, DocumentReviewDecision>;
  docTypePropertyId: string | null;
  workspaceName: string;
  now: Date;
  /** Include AI-drafted narrative sections; defaults to on. */
  aiNarrative?: boolean;
};

export type AssembledReport = {
  /** The AI-visible data object (no ids). */
  data: ReportData;
  /** Source ids behind each citation; never handed to a model. */
  links: ReportLinks;
};

/**
 * Pure assembly of the report data object from already-fetched inputs. Kept
 * free of any DB/model dependency so the derivation (column order, verdict
 * pairing, finding mapping, grouping, stats) is exhaustively testable in
 * isolation.
 */
export const assembleReportData = ({
  entities,
  columns,
  properties,
  justificationByFieldId,
  positionBySourceId = new Map(),
  reviewDecisionByKey = new Map(),
  docTypePropertyId,
  workspaceName,
  now,
  aiNarrative = true,
}: AssembleReportDataArgs): AssembledReport => {
  const verdictInfo = verdictInfoByPropertyId(properties);
  const links: ReportLinks = { citations: new Map() };
  const allFindings: ReportFinding[] = [];
  const review: ReportReviewStats = {
    openFindings: 0,
    acceptedFindings: 0,
    dismissedFindings: 0,
    lockedCells: 0,
    unlockedVerdictCells: 0,
  };
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

  const stats = emptyStats(entities.length);

  const contracts: ReportContract[] = entities.map((entity, entityIndex) => {
    const contractIndex = entityIndex + 1;
    const contractName = entity.name ?? "Untitled";
    const fieldByPropertyId = new Map(
      entity.fields.map((field) => [field.propertyId, field]),
    );
    const lockedByPropertyId = new Map(
      entity.cellMetadata.map((cell) => [
        cell.propertyId,
        cell.metadata.locked === true,
      ]),
    );

    const documentType = docTypePropertyId
      ? formatFieldContent(
          fieldByPropertyId.get(docTypePropertyId)?.content,
          REPORT_LOCALE,
        )
      : "";

    const fields: ReportField[] = [];
    const findings: ReportFinding[] = [];

    for (const column of reportColumns) {
      const askField = fieldByPropertyId.get(column.propertyId);
      const value = formatFieldContent(askField?.content, REPORT_LOCALE);

      const verdictField = column.verdictPropertyId
        ? fieldByPropertyId.get(column.verdictPropertyId)
        : undefined;
      const tier = formatFieldContent(verdictField?.content, REPORT_LOCALE);
      const info = column.verdictPropertyId
        ? verdictInfo.get(column.verdictPropertyId)
        : undefined;

      fields.push({
        label: column.header,
        value,
        verdict: tier,
        severity: info?.severity ?? "",
      });

      if (!(verdictField && info)) {
        continue;
      }
      const locked = lockedByPropertyId.get(verdictField.propertyId) === true;
      if (locked) {
        review.lockedCells += 1;
      } else {
        review.unlockedVerdictCells += 1;
      }
      if (!RISK_VERDICT_TIERS.has(tier)) {
        continue;
      }

      const position = info.playbookSourceId
        ? positionBySourceId.get(info.playbookSourceId)
        : undefined;
      const decision = info.playbookSourceId
        ? reviewDecisionByKey.get(
            reviewDecisionKey(entity.entityId, info.playbookSourceId),
          )
        : undefined;
      const askJustification = askField
        ? justificationByFieldId.get(askField.id)
        : undefined;
      const findingIndex = findings.length + 1;
      const citations: ReportCitation[] = [];
      for (const [offset, item] of citationsFromJustification(
        askJustification?.content,
      ).entries()) {
        citations.push(item.citation);
        if (askJustification) {
          links.citations.set(
            reportCitationKey({
              contractIndex,
              findingIndex,
              citationIndex: offset + 1,
            }),
            {
              entityId: entity.entityId,
              fileFieldId: item.fileFieldId,
              justificationId: askJustification.id,
            },
          );
        }
      }
      const { rationale, matchedRef } = verdictRationaleFromJustification(
        justificationByFieldId.get(verdictField.id)?.content,
      );
      const negotiation = negotiationFromPosition(position);

      findings.push({
        contractIndex,
        findingIndex,
        contractName,
        documentType,
        issue: column.header,
        severity: info.severity,
        verdict: tier,
        rationale,
        matchedRef,
        guidance: position?.guidance ?? "",
        idealText: info.idealText,
        negotiation,
        hasNegotiation: hasNegotiationText(negotiation),
        citations,
        review: { locked, decision: decision ?? "none" },
      });
    }

    for (const finding of findings) {
      countFinding(stats, finding);
      allFindings.push(finding);
      switch (finding.review.decision) {
        case "open":
          review.openFindings += 1;
          break;
        case "accepted":
          review.acceptedFindings += 1;
          break;
        case "dismissed":
          review.dismissedFindings += 1;
          break;
        case "none":
          break;
        default: {
          const exhaustive: never = finding.review.decision;
          return exhaustive;
        }
      }
    }

    const risks = findings.map(riskFromFinding);
    return {
      index: contractIndex,
      name: contractName,
      documentType,
      hasDocumentType: documentType.length > 0,
      riskLevel: worstSeverity(findings.map((finding) => finding.severity)),
      // A riskLevel is only meaningful when the view grades positions; without
      // verdicts every contract is "ok", which is noise, so gate it on the view.
      hasRiskLevel: hasVerdicts,
      fields,
      risks,
      hasRisks: risks.length > 0,
    };
  });

  allFindings.sort(compareFindings);

  const data: ReportData = {
    workspace: { name: workspaceName },
    generatedAt: formatGeneratedAt(now),
    stats,
    contracts,
    findings: allFindings,
    groups: buildGroups(contracts, allFindings),
    review,
    grid: buildReviewGrid(reportColumns, contracts),
    hasVerdicts,
    aiNarrative,
  };
  return { data, links };
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
    kind: column.verdictPropertyId === undefined ? "field" : "graded",
  }));
  const rows: ReportGridRow[] = contracts.map((contract) => {
    const cells: ReportGridCell[] = contract.fields.map((field) => ({
      label: field.label,
      value: field.value,
      verdict: field.verdict,
      severity: field.severity,
    }));
    // The summary folds the verdict tier in as a suffix, mirroring how the
    // per-contract field table surfaces it.
    const segments = cells.map((cell) =>
      cell.verdict
        ? `${cell.label}: ${cell.value} (${cell.verdict})`
        : `${cell.label}: ${cell.value}`,
    );
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
            playbookSourceId: true,
            playbookDefinitionId: true,
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
        excludedKinds: excludedEntityKindsForView(layout.filters),
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
    const verdictPropertyIds = new Set<string>();
    for (const column of propertyColumns) {
      if (column.verdictPropertyId) {
        verdictPropertyIds.add(column.verdictPropertyId);
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

    const justificationByFieldId = new Map<string, ReportJustification>();
    if (commentFieldIds.length > 0) {
      const justificationRows = yield* Result.await(
        safeDb(async (tx) => {
          const rows: {
            id: string;
            fieldId: string;
            content: JustificationContent;
          }[] = [];
          for (
            let index = 0;
            index < commentFieldIds.length;
            index += JUSTIFICATION_FIELD_ID_BATCH
          ) {
            const batch = commentFieldIds.slice(
              index,
              index + JUSTIFICATION_FIELD_ID_BATCH,
            );
            // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop, no-await-in-loop -- sequential reads on one tx connection; the batch caps each `IN (...)` below the bound-parameter limit
            const batchRows = await tx.query.justifications.findMany({
              where: {
                workspaceId: { eq: workspaceId },
                fieldId: { in: batch },
              },
              columns: { id: true, fieldId: true, content: true },
              limit: JUSTIFICATION_FIELD_ID_BATCH,
            });
            rows.push(...batchRows);
          }
          return rows;
        }),
      );
      for (const row of justificationRows) {
        justificationByFieldId.set(row.fieldId, {
          id: row.id,
          content: row.content,
        });
      }
    }

    // Both enrichment loads hinge on graded columns: without verdicts there is
    // no finding to enrich, so skip them.
    const hasVerdicts = commentPropertyIds.size > 0;
    const positionBySourceId = hasVerdicts
      ? yield* Result.await(
          loadGradedPositions({
            safeDb,
            organizationId,
            properties,
            verdictPropertyIds: commentPropertyIds,
          }),
        )
      : new Map<string, GradedPosition>();
    const reviewDecisionByKey = hasVerdicts
      ? yield* Result.await(
          loadReviewDecisions({
            safeDb,
            workspaceId,
            entityIds: queryResult.entities.map((entity) =>
              toSafeId<"entity">(entity.entityId),
            ),
            // The ledger keys findings by the position's stable `sourceId`.
            positionIds: properties.flatMap((property) =>
              verdictPropertyIds.has(property.id) &&
              property.playbookSourceId !== null
                ? [property.playbookSourceId]
                : [],
            ),
          }),
        )
      : new Map<string, DocumentReviewDecision>();

    return Result.ok(
      assembleReportData({
        entities: queryResult.entities,
        columns,
        properties,
        justificationByFieldId,
        positionBySourceId,
        reviewDecisionByKey,
        docTypePropertyId,
        workspaceName,
        now,
        aiNarrative,
      }),
    );
  });

type LoadGradedPositionsArgs = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  properties: (ReportProperty & {
    playbookDefinitionId: SafeId<"playbookDefinition"> | null;
  })[];
  /** Property ids of the visible ASK/verdict columns. */
  verdictPropertyIds: Set<string>;
};

/** The graded positions behind the visible verdict columns, by `sourceId`: one
 *  org-scoped read of the distinct playbook definitions those columns were
 *  materialized from. A deleted definition (FK nulls the column's reference)
 *  simply contributes nothing. */
const loadGradedPositions = async ({
  safeDb,
  organizationId,
  properties,
  verdictPropertyIds,
}: LoadGradedPositionsArgs) =>
  await Result.gen(async function* () {
    const definitionIds = new Set<SafeId<"playbookDefinition">>();
    for (const property of properties) {
      if (
        verdictPropertyIds.has(property.id) &&
        property.playbookDefinitionId
      ) {
        definitionIds.add(property.playbookDefinitionId);
      }
    }
    const positionBySourceId = new Map<string, GradedPosition>();
    if (definitionIds.size === 0) {
      return Result.ok(positionBySourceId);
    }
    const definitions = yield* Result.await(
      safeDb((tx) =>
        tx.query.playbookDefinitions.findMany({
          where: {
            organizationId: { eq: organizationId },
            id: { in: [...definitionIds] },
          },
          columns: { positions: true },
          limit: definitionIds.size,
        }),
      ),
    );
    for (const definition of definitions) {
      for (const position of definition.positions.items) {
        if (position.mode === "graded") {
          positionBySourceId.set(position.sourceId, position);
        }
      }
    }
    return Result.ok(positionBySourceId);
  });

type LoadReviewDecisionsArgs = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityIds: SafeId<"entity">[];
  /** Playbook position ids (`sourceId`) behind the visible verdict columns;
   *  filters the ledger and bounds the rows per entity. */
  positionIds: string[];
};

/** Reviewer decisions of the playbook findings graded against each entity's
 *  CURRENT version, keyed by {@link reviewDecisionKey}. Only DOCX review runs
 *  write this ledger, so most contracts have no row and read as "none".
 *
 *  Only completed runs count: findings are persisted before a run is
 *  finalized and before decisions carry over, so a running or failed run's
 *  `open` rows must not shadow the last completed review. One row per
 *  `(entity, position)` is selected in SQL (`DISTINCT ON`, newest completed
 *  run first), so the limit bounds current rows and can never cut them off
 *  behind stale reruns. */
export const loadReviewDecisions = async ({
  safeDb,
  workspaceId,
  entityIds,
  positionIds,
}: LoadReviewDecisionsArgs) =>
  await Result.gen(async function* () {
    const byKey = new Map<string, DocumentReviewDecision>();
    if (entityIds.length === 0 || positionIds.length === 0) {
      return Result.ok(byKey);
    }
    // The entity list is the report's row page (LIMITS.reportExportMaxRows
    // plus the overflow sentinel), so one `IN (...)` always fits; a longer
    // list is a caller bug, not a case to page through.
    if (entityIds.length > JUSTIFICATION_FIELD_ID_BATCH) {
      return panic(
        `loadReviewDecisions: ${entityIds.length} entity ids exceed the single-query bound ${JUSTIFICATION_FIELD_ID_BATCH}`,
      );
    }
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx
            .selectDistinctOn(
              [
                documentReviewFindings.entityId,
                documentReviewFindings.positionId,
              ],
              {
                entityId: documentReviewFindings.entityId,
                positionId: documentReviewFindings.positionId,
                decision: documentReviewFindings.decision,
              },
            )
            .from(documentReviewFindings)
            .innerJoin(
              documentReviewRuns,
              and(
                eq(documentReviewRuns.id, documentReviewFindings.runId),
                eq(documentReviewRuns.status, "completed"),
              ),
            )
            .innerJoin(
              entitiesTable,
              and(
                eq(entitiesTable.id, documentReviewFindings.entityId),
                eq(
                  entitiesTable.currentVersionId,
                  documentReviewFindings.entityVersionId,
                ),
              ),
            )
            .where(
              and(
                eq(documentReviewFindings.workspaceId, workspaceId),
                inArray(documentReviewFindings.entityId, entityIds),
                inArray(documentReviewFindings.positionId, positionIds),
              ),
            )
            // Runs on one document are serialized (one active run at a time),
            // so creation order is completion order; the same key the
            // decision carry-over uses to find the superseded run.
            .orderBy(
              documentReviewFindings.entityId,
              documentReviewFindings.positionId,
              desc(documentReviewRuns.createdAt),
              desc(documentReviewRuns.id),
            )
            // `DISTINCT ON` yields at most one row per (entity, visible
            // position); stating it as a limit keeps the bound visible.
            .limit(entityIds.length * positionIds.length),
      ),
    );
    for (const row of rows) {
      byKey.set(reviewDecisionKey(row.entityId, row.positionId), row.decision);
    }
    return Result.ok(byKey);
  });
