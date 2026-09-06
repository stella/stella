/**
 * Interpret a {@link ReportSpec} against an assembled report and emit a DOCX
 * through the Folio document model (`stellaDocument` → blocks →
 * `documentToDocx`).
 *
 * Rendering never throws for missing data: an absent value renders as an
 * empty string or an omitted paragraph. Narrative sections call the AI
 * generator sequentially and are dropped entirely (heading included) when
 * narrative is off or no generator exists. A failed requested draft fails
 * the report, so exports cannot silently omit requested sections.
 *
 * Citation links: the data object carries no ids (AI hygiene), so a link is
 * resolved at render time from `report.links` by the citation's positional
 * key, and only when a `linkBase` is supplied.
 */

import { panic, Result } from "better-result";

import { compareByLocale } from "@stll/collation";
import {
  createTableOfContentsField,
  endnote,
  heading,
  hyperlink,
  pageBreak,
  paragraph,
  run,
  table,
} from "@stll/folio-core/server";
import type { HeadingLevel, TableCellSpec } from "@stll/folio-core/server";

import type {
  AssembledReport,
  ReportContract,
  ReportFinding,
  ReportGrid,
  ReportGridCell,
  ReportGridColumn,
  ReportGroup,
  ReportStats,
} from "@/api/handlers/reports/build-report-data";
import { reportCitationKey } from "@/api/handlers/reports/build-report-data";
import type {
  ReportCitation,
  ReportCitationLink,
} from "@/api/handlers/reports/report-findings";
import { SEVERITY_ORDER } from "@/api/handlers/reports/report-findings";
import type {
  FindingColumn,
  MatrixColumns,
  ReportSection,
  ReportSpec,
} from "@/api/handlers/reports/spec/report-spec";
import { interpolate } from "@/api/handlers/reports/spec/report-spec";
import {
  documentToDocx,
  stellaDocument,
} from "@/api/lib/docx-authoring/document";
import type { AiFieldGenerator } from "@/api/lib/docx/resolve-ai-fields";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-position-facets";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";
import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";

type Document = ReturnType<typeof stellaDocument>;
type Paragraph = ReturnType<typeof paragraph>;
type Table = ReturnType<typeof table>;
type Block = Paragraph | Table;
type Run = ReturnType<typeof run>;
type ParagraphContent = Exclude<
  Parameters<typeof paragraph>[0],
  string
>[number];
type ShadingProperties = NonNullable<
  Extract<TableCellSpec, { content: unknown }>["shading"]
>;

/** Where citation links point: the document route of the exported view. */
export type ReportLinkBase = {
  appUrl: string;
  workspaceId: string;
  viewId: string;
};

export type RenderReportSpecOptions = {
  spec: ReportSpec;
  report: AssembledReport;
  /** Prompt texts by `ref` (`prompts/<ref>.md`). */
  prompts: Map<string, string>;
  generateAiValue?: AiFieldGenerator | undefined;
  aiNarrative: boolean;
  linkBase?: ReportLinkBase | undefined;
};

export class RenderReportError extends ConfigurationError {
  override readonly name = "RenderReportError";
}

/** Usable text width of the default (Letter, 1" margins) page, in twips. */
const TEXT_WIDTH = 9360;
const FIELD_LABEL_COL = 2900;
const FIELD_VALUE_COL = 3760;
const MATRIX_NAME_COL = 2400;
const STATS_LABEL_COL = 4500;
/** Narrow numeric column of the document-type stats table. */
const STATS_COUNT_COL = 900;
/** Fixed widths of the findings-table columns; the free-text columns share
 *  what is left. */
const FINDING_COLUMN_WIDTHS = {
  severity: 1100,
  contract: 2000,
  documentType: 1600,
  issue: 1800,
  verdict: 1100,
  rationale: null,
  recommendation: null,
} as const satisfies Record<FindingColumn, number | null>;
/** Matrix cell text: 8pt (half-points), value truncated with an ellipsis. */
const MATRIX_CELL_FONT_SIZE = 16;
const MATRIX_VALUE_MAX_CHARS = 60;
const ELLIPSIS = "…";

const GRAY = "808080";
const CAPTION_FORMATTING = { italic: true, color: { rgb: GRAY }, fontSize: 18 };
const HEADER_SHADING: ShadingProperties = {
  fill: { rgb: "E7E6E6" },
  pattern: "clear",
};
const LEAD_SEPARATOR = "  ·  ";
const UNCLASSIFIED_LABEL = "Unclassified";
const HEADER_RID = "rIdReportHeader";
const FOOTER_RID = "rIdReportFooter";
const MAX_HEADING_LEVEL: HeadingLevel = 3;
/** Word's default (0.5"), used only when the preset sets no tab stop. */
const DEFAULT_TAB_STOP = 720;

const SEVERITY_LABELS = {
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
  low: "Low",
} as const satisfies Record<PositionSeverity, string>;

const SEVERITY_SHADING = {
  blocker: { fill: { rgb: "F4CCCC" }, pattern: "clear" },
  high: { fill: { rgb: "FCE5CD" }, pattern: "clear" },
  medium: { fill: { rgb: "FFF2CC" }, pattern: "clear" },
  low: { fill: { rgb: "D9EAD3" }, pattern: "clear" },
} as const satisfies Record<PositionSeverity, ShadingProperties>;

/** Light fills that stay readable in print. */
const VERDICT_SHADING = {
  compliant: { fill: { rgb: "D9EAD3" }, pattern: "clear" },
  fallback: { fill: { rgb: "FFF2CC" }, pattern: "clear" },
  deviation: { fill: { rgb: "F4CCCC" }, pattern: "clear" },
  missing: { fill: { rgb: "F4CCCC" }, pattern: "clear" },
  additional: { fill: { rgb: "D0E0F0" }, pattern: "clear" },
  "not-applicable": { fill: { rgb: "EDEDED" }, pattern: "clear" },
} as const satisfies Record<VerdictTier, ShadingProperties>;

const VERDICT_LABELS = {
  compliant: "Compliant",
  fallback: "Fallback",
  deviation: "Deviation",
  missing: "Missing",
  additional: "Additional",
  "not-applicable": "N/A",
} as const satisfies Record<VerdictTier, string>;

const isVerdictTier = (value: string): value is VerdictTier =>
  VERDICT_TIERS.some((tier) => tier === value);

const FINDING_COLUMN_LABELS = {
  severity: "Severity",
  contract: "Contract",
  documentType: "Document type",
  issue: "Issue",
  verdict: "Verdict",
  rationale: "Rationale",
  recommendation: "Recommendation",
} as const satisfies Record<FindingColumn, string>;

/** Report display locale (the data object is language-neutral). */
const REPORT_LOCALE = "en";
const compareDocumentTypeLabel = compareByLocale(REPORT_LOCALE);

const documentTypeLabel = (documentType: string): string =>
  documentType.length > 0 ? documentType : UNCLASSIFIED_LABEL;

const recommendationText = (finding: ReportFinding): string =>
  finding.guidance || finding.negotiation.rationale || finding.idealText;

const findingCell = (
  finding: ReportFinding,
  column: FindingColumn,
): TableCellSpec => {
  switch (column) {
    case "severity":
      return {
        content: [paragraph(SEVERITY_LABELS[finding.severity])],
        shading: SEVERITY_SHADING[finding.severity],
      };
    case "contract":
      return finding.contractName;
    case "documentType":
      return documentTypeLabel(finding.documentType);
    case "issue":
      return finding.issue;
    case "verdict":
      return finding.verdict;
    case "rationale":
      return finding.rationale;
    case "recommendation":
      return recommendationText(finding);
    default: {
      column satisfies never;
      return panic(`Unhandled column: ${String(column)}`);
    }
  }
};

/** Mutable per-render state shared across sections. */
type RenderContext = {
  doc: Document;
  report: AssembledReport;
  prompts: Map<string, string>;
  generateAiValue: AiFieldGenerator | undefined;
  aiNarrative: boolean;
  linkBase: ReportLinkBase | undefined;
  /** Sequential narrative counter; names the generator's `fieldPath`. */
  narrativeCount: number;
  narrativeFailures: string[];
};

/** What a section sees: the whole report at root, one group inside `grouped`. */
type Scope = ({ type: "root" } | { type: "group"; group: ReportGroup }) & {
  /** Heading level for a section's own optional heading. */
  headingLevel: HeadingLevel;
};

const scopeContracts = (ctx: RenderContext, scope: Scope): ReportContract[] =>
  scope.type === "group" ? scope.group.contracts : ctx.report.data.contracts;

const scopeFindings = (ctx: RenderContext, scope: Scope): ReportFinding[] =>
  scope.type === "group" ? scope.group.findings : ctx.report.data.findings;

const scopeStats = (ctx: RenderContext, scope: Scope): ReportStats =>
  scope.type === "group" ? scope.group.stats : ctx.report.data.stats;

/** The object a narrative generator is grounded in: the AI-visible data
 *  (never `links`) at root, the group inside `grouped`. */
const scopeAiValues = (
  ctx: RenderContext,
  scope: Scope,
): Record<string, unknown> =>
  scope.type === "group" ? { ...scope.group } : { ...ctx.report.data };

const rootInterpolationValues = (
  ctx: RenderContext,
): Record<string, string> => ({
  "workspace.name": ctx.report.data.workspace.name,
  generatedAt: ctx.report.data.generatedAt,
});

const deeper = (level: HeadingLevel): HeadingLevel => {
  if (level >= MAX_HEADING_LEVEL) {
    return MAX_HEADING_LEVEL;
  }
  return level === 1 ? 2 : 3;
};

const optionalHeading = (
  text: string | undefined,
  level: HeadingLevel,
): Block[] =>
  text === undefined || text.length === 0 ? [] : [heading({ text, level })];

const captionParagraph = (text: string): Paragraph =>
  paragraph([run(text, CAPTION_FORMATTING)]);

const labelledParagraph = (label: string, text: string): Paragraph =>
  paragraph([run(`${label} `, { bold: true }), run(text)]);

/** Split generated prose on blank lines into body paragraphs. */
const proseParagraphs = (text: string): Paragraph[] =>
  text
    .split(/\n\s*\n/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => paragraph(part));

const evenWidths = (total: number, count: number): number[] => {
  if (count === 0) {
    return [];
  }
  const width = Math.floor(total / count);
  return Array.from({ length: count }, () => width);
};

/** Fixed widths where declared; the `null` columns share the remainder. When
 *  every column is fixed, the last one absorbs the slack so the grid spans
 *  the text block. */
const sharedWidths = (fixed: (number | null)[]): number[] => {
  const used = fixed.reduce<number>((sum, width) => sum + (width ?? 0), 0);
  const free = fixed.filter((width) => width === null).length;
  const remaining = Math.max(TEXT_WIDTH - used, 0);
  if (free === 0) {
    const last = fixed.length - 1;
    return fixed.map((width, index) =>
      index === last ? (width ?? 0) + remaining : (width ?? 0),
    );
  }
  const share = Math.floor(remaining / free);
  return fixed.map((width) => width ?? share);
};

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars - 1)}${ELLIPSIS}` : text;

// ── Citations ────────────────────────────────────────────────────────────────

type CitationAddress = {
  contractIndex: number;
  findingIndex: number;
  citationIndex: number;
};

const citationUrl = (
  linkBase: ReportLinkBase,
  link: ReportCitationLink,
  citation: ReportCitation,
): string => {
  const url = new URL(
    `${linkBase.appUrl}/workspaces/${linkBase.workspaceId}/${linkBase.viewId}/document`,
  );
  url.searchParams.set("entity", link.entityId);
  url.searchParams.set("field", link.fileFieldId);
  url.searchParams.set("justification", link.justificationId);
  switch (citation.kind) {
    case "pdf":
      // The document route highlights the justification only when both
      // `justification` and `justificationPage` are set; `pdfPage` scrolls.
      url.searchParams.set("justificationPage", String(citation.pageNumber));
      url.searchParams.set("pdfPage", String(citation.pageNumber));
      break;
    case "docx":
      url.searchParams.set("block", citation.blockId);
      break;
    default: {
      citation satisfies never;
      return panic(`Unhandled citation: ${String(citation)}`);
    }
  }
  return url.toString();
};

/** A citation that may be quoted as source language (see
 *  `quotableCitationText`); an ungrounded docx hint is never rendered. */
const isQuotable = (citation: ReportCitation): boolean => {
  switch (citation.kind) {
    case "docx":
      return citation.grounded;
    case "pdf":
      return true;
    default: {
      citation satisfies never;
      return panic(`Unhandled citation: ${String(citation)}`);
    }
  }
};

const citationLocator = (citation: ReportCitation): string => {
  switch (citation.kind) {
    case "docx":
      return "";
    case "pdf":
      return citation.bates.length > 0
        ? ` (${citation.bates}, p. ${citation.pageNumber})`
        : ` (p. ${citation.pageNumber})`;
    default: {
      citation satisfies never;
      return panic(`Unhandled citation: ${String(citation)}`);
    }
  }
};

const citationEndnote = (
  ctx: RenderContext,
  address: CitationAddress,
  citation: ReportCitation,
): Run => {
  const content: ParagraphContent[] = [
    run(`“${citation.text}”${citationLocator(citation)}`),
  ];
  const link = ctx.report.links.citations.get(reportCitationKey(address));
  if (ctx.linkBase && link) {
    content.push(run(" "));
    content.push(
      hyperlink({
        text: "Open in stella",
        href: citationUrl(ctx.linkBase, link, citation),
      }),
    );
  }
  return endnote(ctx.doc, [paragraph(content, { styleId: "EndnoteText" })]);
};

// ── Sections ─────────────────────────────────────────────────────────────────

type SectionOf<K extends ReportSection["kind"]> = Extract<
  ReportSection,
  { kind: K }
>;

const renderCover = (
  section: SectionOf<"cover">,
  ctx: RenderContext,
): Block[] => {
  const values = rootInterpolationValues(ctx);
  const blocks: Block[] = [
    paragraph(interpolate(section.title, values), { styleId: "Title" }),
  ];
  if (section.subtitle !== undefined) {
    blocks.push(
      paragraph(interpolate(section.subtitle, values), { styleId: "Subtitle" }),
    );
  }
  if (section.notice !== undefined) {
    blocks.push(captionParagraph(interpolate(section.notice, values)));
  }
  // The cover owns its page.
  blocks.push(pageBreak());
  return blocks;
};

const renderToc = (section: SectionOf<"toc">): Block[] => [
  paragraph("Contents", { styleId: "TOCHeading" }),
  createTableOfContentsField({ levels: section.levels ?? { from: 1, to: 2 } }),
];

const renderNarrative = async (
  section: SectionOf<"narrative">,
  ctx: RenderContext,
  scope: Scope,
): Promise<Block[]> => {
  if (!(ctx.aiNarrative && ctx.generateAiValue)) {
    return [];
  }
  const prompt =
    "text" in section.prompt
      ? section.prompt.text
      : ctx.prompts.get(section.prompt.ref);
  if (prompt === undefined) {
    return [];
  }
  ctx.narrativeCount += 1;
  const draft = await ctx.generateAiValue({
    prompt,
    fieldPath: `narrative.${ctx.narrativeCount}`,
    values: scopeAiValues(ctx, scope),
  });
  if (draft.type === "failed") {
    ctx.narrativeFailures.push(
      `narrative.${String(ctx.narrativeCount)}: ${draft.reason}`,
    );
    return [];
  }
  return [
    ...optionalHeading(section.heading, section.level ?? scope.headingLevel),
    ...proseParagraphs(draft.value),
  ];
};

const severityStatsTable = (stats: ReportStats): Table =>
  table({
    header: ["Severity", "Findings"],
    headerShading: HEADER_SHADING,
    columnWidths: [STATS_LABEL_COL, TEXT_WIDTH - STATS_LABEL_COL],
    rows: [
      ...SEVERITY_ORDER.map((severity) => [
        SEVERITY_LABELS[severity],
        String(stats.bySeverity[severity]),
      ]),
      [
        { content: [paragraph([run("Total", { bold: true })])] },
        { content: [paragraph([run(String(stats.redFlags), { bold: true })])] },
      ],
    ],
  });

const documentTypeStatsTable = (groups: ReportGroup[]): Table =>
  table({
    header: [
      "Document type",
      "Contracts",
      ...SEVERITY_ORDER.map((severity) => SEVERITY_LABELS[severity]),
      "Total",
    ],
    headerShading: HEADER_SHADING,
    columnWidths: sharedWidths([
      null,
      ...Array.from(
        { length: SEVERITY_ORDER.length + 2 },
        () => STATS_COUNT_COL,
      ),
    ]),
    rows: groups.map((group) => [
      documentTypeLabel(group.documentType),
      String(group.stats.total),
      ...SEVERITY_ORDER.map((severity) =>
        String(group.stats.bySeverity[severity]),
      ),
      String(group.stats.redFlags),
    ]),
  });

const renderStats = (
  section: SectionOf<"stats">,
  ctx: RenderContext,
  scope: Scope,
): Block[] => {
  const body =
    section.by === "severity"
      ? severityStatsTable(scopeStats(ctx, scope))
      : documentTypeStatsTable(ctx.report.data.groups);
  return [...optionalHeading(section.heading, scope.headingLevel), body];
};

const renderFindingsTable = (
  section: SectionOf<"findings-table">,
  ctx: RenderContext,
  scope: Scope,
): Block[] => {
  const allowed = section.severity ? new Set(section.severity) : null;
  let findings = scopeFindings(ctx, scope).filter(
    (finding) => allowed === null || allowed.has(finding.severity),
  );
  if (section.limit !== undefined) {
    findings = findings.slice(0, section.limit);
  }
  const body = table({
    header: section.columns.map((column) => FINDING_COLUMN_LABELS[column]),
    headerShading: HEADER_SHADING,
    columnWidths: sharedWidths(
      section.columns.map((column) => FINDING_COLUMN_WIDTHS[column]),
    ),
    rows: findings.map((finding) =>
      section.columns.map((column) => findingCell(finding, column)),
    ),
  });
  return [...optionalHeading(section.heading, scope.headingLevel), body];
};

const findingLead = (finding: ReportFinding): Run[] => [
  run(
    [finding.issue, SEVERITY_LABELS[finding.severity], finding.verdict].join(
      LEAD_SEPARATOR,
    ),
    { bold: true },
  ),
];

const renderFindingParts = (
  section: SectionOf<"findings">,
  finding: ReportFinding,
): Block[] => {
  const blocks: Block[] = [];
  for (const part of section.include) {
    switch (part) {
      case "rationale":
        if (finding.rationale.length > 0) {
          blocks.push(labelledParagraph("Why:", finding.rationale));
        }
        break;
      case "matchedRef":
        if (finding.matchedRef.kind !== "none") {
          const label = finding.matchedRef.label;
          blocks.push(
            labelledParagraph(
              "Matched:",
              label.length > 0
                ? `${label}: ${finding.matchedRef.text}`
                : finding.matchedRef.text,
            ),
          );
        }
        break;
      case "idealText":
        if (finding.idealText.length > 0) {
          blocks.push(labelledParagraph("Should say:", finding.idealText));
        }
        break;
      case "guidance":
        if (finding.guidance.length > 0) {
          blocks.push(labelledParagraph("Recommendation:", finding.guidance));
        }
        break;
      case "negotiation":
        if (finding.hasNegotiation) {
          blocks.push(
            labelledParagraph("Negotiation:", finding.negotiation.rationale),
          );
          for (const point of finding.negotiation.talkingPoints) {
            blocks.push(paragraph(`– ${point}`));
          }
          if (finding.negotiation.escalation.length > 0) {
            blocks.push(
              labelledParagraph("Escalation:", finding.negotiation.escalation),
            );
          }
        }
        break;
      default: {
        part satisfies never;
        return panic(`Unhandled part: ${String(part)}`);
      }
    }
  }
  return blocks;
};

const renderFindings = (
  section: SectionOf<"findings">,
  ctx: RenderContext,
  scope: Scope,
): Block[] => {
  const suppressed = new Set(section.suppressVerdicts);
  const severities = section.severity ? new Set(section.severity) : null;
  const findings = scopeFindings(ctx, scope).filter(
    (finding) =>
      !suppressed.has(finding.verdict) &&
      (severities === null || severities.has(finding.severity)),
  );
  const blocks: Block[] = [];
  for (const contract of scopeContracts(ctx, scope)) {
    const own = findings
      .filter((finding) => finding.contractIndex === contract.index)
      .sort((a, b) => a.findingIndex - b.findingIndex);
    if (own.length === 0) {
      continue;
    }
    blocks.push(heading({ text: contract.name, level: 3 }));
    for (const finding of own) {
      const lead = findingLead(finding);
      const inline: Paragraph[] = [];
      for (const [offset, citation] of finding.citations.entries()) {
        if (!isQuotable(citation)) {
          continue;
        }
        switch (section.citations) {
          case "endnote":
            lead.push(
              citationEndnote(
                ctx,
                {
                  contractIndex: finding.contractIndex,
                  findingIndex: finding.findingIndex,
                  citationIndex: offset + 1,
                },
                citation,
              ),
            );
            break;
          case "inline":
            inline.push(
              captionParagraph(
                `Citation: “${citation.text}”${citationLocator(citation)}`,
              ),
            );
            break;
          case "none":
            break;
          default: {
            section.citations satisfies never;
            return panic(`Unhandled citations: ${String(section.citations)}`);
          }
        }
      }
      blocks.push(paragraph(lead));
      blocks.push(...renderFindingParts(section, finding));
      blocks.push(...inline);
    }
  }
  return blocks;
};

const contractFieldsTable = (
  contract: ReportContract,
  hasVerdicts: boolean,
): Table =>
  hasVerdicts
    ? table({
        header: ["Field", "Value", "Verdict"],
        headerShading: HEADER_SHADING,
        columnWidths: [
          FIELD_LABEL_COL,
          FIELD_VALUE_COL,
          TEXT_WIDTH - FIELD_LABEL_COL - FIELD_VALUE_COL,
        ],
        rows: contract.fields.map((field) => [
          { content: [paragraph([run(field.label, { bold: true })])] },
          field.value,
          field.verdict,
        ]),
      })
    : table({
        header: ["Field", "Value"],
        headerShading: HEADER_SHADING,
        columnWidths: [FIELD_LABEL_COL, TEXT_WIDTH - FIELD_LABEL_COL],
        rows: contract.fields.map((field) => [
          { content: [paragraph([run(field.label, { bold: true })])] },
          field.value,
        ]),
      });

type RenderContractOptions = {
  contract: ReportContract;
  hasVerdicts: boolean;
  /** Level of the contract heading; its "Risks" heading sits one deeper. */
  level: HeadingLevel;
};

const renderContract = ({
  contract,
  hasVerdicts,
  level,
}: RenderContractOptions): Block[] => {
  const blocks: Block[] = [
    heading({ text: `${contract.index}. ${contract.name}`, level }),
  ];
  if (contract.hasDocumentType) {
    blocks.push(captionParagraph(`Document type: ${contract.documentType}`));
  }
  if (contract.hasRiskLevel) {
    blocks.push(captionParagraph(`Risk level: ${contract.riskLevel}`));
  }
  blocks.push(contractFieldsTable(contract, hasVerdicts));
  if (!contract.hasRisks) {
    return blocks;
  }
  blocks.push(heading({ text: "Risks", level: deeper(level) }));
  for (const risk of contract.risks) {
    blocks.push(
      paragraph([
        run([risk.issue, risk.severity, risk.verdict].join(LEAD_SEPARATOR), {
          bold: true,
        }),
      ]),
    );
    if (risk.rationale.length > 0) {
      blocks.push(paragraph(risk.rationale));
    }
    if (risk.hasCitation) {
      blocks.push(captionParagraph(`Citation: ${risk.citation}`));
    }
  }
  return blocks;
};

const renderPerContract = (
  section: SectionOf<"per-contract">,
  ctx: RenderContext,
  scope: Scope,
): Block[] => [
  ...optionalHeading(section.heading, scope.headingLevel),
  // Contracts sit one level below the scope's heading (the group heading
  // inside `grouped`, the document title at root), capped at the deepest
  // styled level.
  ...scopeContracts(ctx, scope).flatMap((contract) =>
    renderContract({
      contract,
      hasVerdicts: ctx.report.data.hasVerdicts,
      level: deeper(scope.headingLevel),
    }),
  ),
];

const matrixCellParagraph = (text: string): Paragraph =>
  paragraph([run(text, { fontSize: MATRIX_CELL_FONT_SIZE })]);

/** A graded cell shows only its verdict tier, shaded, or stays blank while
 *  the verdict is unset (the extracted clause text is not a grade); any other
 *  cell shows the truncated value. A verdict outside the known tiers (a
 *  hand-edited option) renders as plain text rather than a guessed fill. */
const matrixCell = (
  column: ReportGridColumn,
  cell: ReportGridCell,
): TableCellSpec => {
  if (column.kind === "field") {
    return {
      content: [
        matrixCellParagraph(truncate(cell.value, MATRIX_VALUE_MAX_CHARS)),
      ],
    };
  }
  if (cell.verdict.length === 0) {
    return "";
  }
  if (!isVerdictTier(cell.verdict)) {
    return { content: [matrixCellParagraph(cell.verdict)] };
  }
  return {
    content: [matrixCellParagraph(VERDICT_LABELS[cell.verdict])],
    shading: VERDICT_SHADING[cell.verdict],
  };
};

/** Indexes of the grid columns the section keeps. Graded-ness is a property
 *  of the column, so a graded column stays even while every verdict is unset. */
const matrixColumnIndexes = (
  grid: ReportGrid,
  columns: MatrixColumns,
): number[] => {
  const all = grid.columns.map((_column, index) => index);
  switch (columns) {
    case "all":
      return all;
    case "graded":
      return all.filter((index) => grid.columns.at(index)?.kind === "graded");
    default: {
      columns satisfies never;
      return panic(`Unhandled columns: ${String(columns)}`);
    }
  }
};

const renderMatrix = (
  section: SectionOf<"matrix">,
  ctx: RenderContext,
  scope: Scope,
): Block[] => {
  const { grid } = ctx.report.data;
  const indexes = matrixColumnIndexes(grid, section.columns);
  const body = table({
    header: [
      "Contract",
      ...indexes.map((index) => grid.columns.at(index)?.label ?? ""),
    ],
    headerShading: HEADER_SHADING,
    columnWidths: [
      MATRIX_NAME_COL,
      ...evenWidths(TEXT_WIDTH - MATRIX_NAME_COL, indexes.length),
    ],
    repeatHeader: true,
    rows: grid.rows.map((row) => {
      const cells: TableCellSpec[] = [
        { content: [matrixCellParagraph(row.name)] },
      ];
      for (const index of indexes) {
        const column = grid.columns.at(index);
        const cell = row.cells.at(index);
        cells.push(
          column === undefined || cell === undefined
            ? ""
            : matrixCell(column, cell),
        );
      }
      return cells;
    }),
  });
  return [...optionalHeading(section.heading, scope.headingLevel), body];
};

const orderedGroups = (
  groups: ReportGroup[],
  order: SectionOf<"grouped">["order"],
): ReportGroup[] => {
  switch (order) {
    case "redFlagsDesc":
      // The builder already orders groups worst first.
      return groups;
    case "name":
      return [...groups].sort((a, b) =>
        compareDocumentTypeLabel(
          documentTypeLabel(a.documentType),
          documentTypeLabel(b.documentType),
        ),
      );
    default: {
      order satisfies never;
      return panic(`Unhandled order: ${String(order)}`);
    }
  }
};

/** `render` over `items` one at a time, in order, blocks concatenated.
 *  Narrative sections call the model, and those drafts are metered one at a
 *  time in document order by design, so this never fans out. */
const renderInOrder = async <T>(
  items: readonly T[],
  render: (item: T) => Promise<Block[]>,
): Promise<Block[]> => {
  const blocks: Block[] = [];
  const renderFrom = async (index: number): Promise<Block[]> => {
    const item = items.at(index);
    if (item === undefined) {
      return blocks;
    }
    blocks.push(...(await render(item)));
    return await renderFrom(index + 1);
  };
  return await renderFrom(0);
};

const renderGrouped = async (
  section: SectionOf<"grouped">,
  ctx: RenderContext,
): Promise<Block[]> => {
  const level = section.level ?? 1;
  return await renderInOrder(
    orderedGroups(ctx.report.data.groups, section.order),
    async (group) => {
      const scope: Scope = {
        type: "group",
        group,
        headingLevel: deeper(level),
      };
      const children = await renderInOrder(
        section.children,
        async (child) => await renderSection(child, ctx, scope),
      );
      return [
        heading({
          text: interpolate(section.heading, {
            ...rootInterpolationValues(ctx),
            "group.documentType": documentTypeLabel(group.documentType),
          }),
          level,
        }),
        ...children,
      ];
    },
  );
};

const renderAppendix = async (
  section: SectionOf<"appendix">,
  ctx: RenderContext,
): Promise<Block[]> => {
  const scope: Scope = { type: "root", headingLevel: 2 };
  const children = await renderInOrder(
    section.children,
    async (child) => await renderSection(child, ctx, scope),
  );
  return [
    pageBreak(),
    heading({ text: section.heading, level: 1 }),
    ...children,
  ];
};

const renderSection = async (
  section: ReportSection,
  ctx: RenderContext,
  scope: Scope,
): Promise<Block[]> => {
  switch (section.kind) {
    case "cover":
      return renderCover(section, ctx);
    case "toc":
      return renderToc(section);
    case "page-break":
      return [pageBreak()];
    case "narrative":
      return await renderNarrative(section, ctx, scope);
    case "stats":
      return renderStats(section, ctx, scope);
    case "findings-table":
      return renderFindingsTable(section, ctx, scope);
    case "grouped":
      return await renderGrouped(section, ctx);
    case "findings":
      return renderFindings(section, ctx, scope);
    case "per-contract":
      return renderPerContract(section, ctx, scope);
    case "matrix":
      return renderMatrix(section, ctx, scope);
    case "appendix":
      return await renderAppendix(section, ctx);
    default: {
      section satisfies never;
      return panic(`Unhandled section: ${String(section)}`);
    }
  }
};

/** Whether rendering `sections` with narrative on can call the generator;
 *  gates the AI usage preflight so a deterministic spec spends no quota. */
export const hasNarrativeSection = (sections: ReportSection[]): boolean =>
  sections.some((section) => {
    switch (section.kind) {
      case "narrative":
        return true;
      case "grouped":
      case "appendix":
        return hasNarrativeSection(section.children);
      case "cover":
      case "toc":
      case "page-break":
      case "stats":
      case "findings-table":
      case "findings":
      case "per-contract":
      case "matrix":
        return false;
      default: {
        section satisfies never;
        return panic(`Unhandled section: ${String(section)}`);
      }
    }
  });

// ── Document shell ───────────────────────────────────────────────────────────

const pageField = (fieldType: "PAGE" | "NUMPAGES"): ParagraphContent => ({
  type: "complexField",
  instruction: fieldType,
  fieldType,
  fieldCode: [],
  fieldResult: [run("1", CAPTION_FORMATTING)],
});

const installHeaderFooter = (doc: Document, workspaceName: string): void => {
  doc.package.headers = new Map([
    [
      HEADER_RID,
      {
        type: "header",
        hdrFtrType: "default",
        content: [paragraph([run(workspaceName, CAPTION_FORMATTING)])],
      },
    ],
  ]);
  doc.package.footers = new Map([
    [
      FOOTER_RID,
      {
        type: "footer",
        hdrFtrType: "default",
        content: [
          paragraph(
            [
              run("Page ", CAPTION_FORMATTING),
              pageField("PAGE"),
              run(" of ", CAPTION_FORMATTING),
              pageField("NUMPAGES"),
            ],
            { styleId: "Footer" },
          ),
        ],
      },
    ],
  ]);
  doc.package.document.finalSectionProperties = {
    ...doc.package.document.finalSectionProperties,
    headerReferences: [{ type: "default", rId: HEADER_RID }],
    footerReferences: [{ type: "default", rId: FOOTER_RID }],
    // Citations read 1, 2, 3 rather than Word's default lowercase roman.
    endnotePr: { numFmt: "decimal" },
  };
};

export const renderReportSpec = async ({
  spec,
  report,
  prompts,
  generateAiValue,
  aiNarrative,
  linkBase,
}: RenderReportSpecOptions): Promise<Result<Buffer, RenderReportError>> => {
  const doc = stellaDocument();
  doc.package.settings = {
    defaultTabStop: DEFAULT_TAB_STOP,
    ...doc.package.settings,
    updateFields: true,
  };
  installHeaderFooter(doc, report.data.workspace.name);

  const ctx: RenderContext = {
    doc,
    report,
    prompts,
    generateAiValue,
    aiNarrative,
    linkBase,
    narrativeCount: 0,
    narrativeFailures: [],
  };
  const scope: Scope = { type: "root", headingLevel: 1 };
  const blocks = await renderInOrder(
    spec.sections,
    async (section) => await renderSection(section, ctx, scope),
  );
  if (ctx.narrativeFailures.length > 0) {
    return Result.err(
      new RenderReportError({
        message: `Report narrative generation failed: ${ctx.narrativeFailures.join(", ")}`,
      }),
    );
  }
  // A body must end with a paragraph (Word rejects a trailing table).
  if (blocks.at(-1)?.type === "table") {
    blocks.push(paragraph(""));
  }
  doc.package.document.content = blocks;

  const written = await Result.tryPromise({
    try: async () => Buffer.from(await documentToDocx(doc)),
    catch: (cause) =>
      new RenderReportError({
        message: `Failed to write the report DOCX for spec "${spec.name}".`,
        cause,
      }),
  });
  return written;
};
