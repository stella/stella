/**
 * The issues table a reviewer hands to the other side or to the client: one
 * row per finding, read top to bottom in the order the results panel shows
 * them. Pure over the persisted run row and its findings, so the spreadsheet
 * and Word renderings cannot drift from each other.
 */

import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  heading,
  paragraph,
  run,
  table,
} from "@stll/folio-core/server";
import type { TableCellSpec } from "@stll/folio-core/server";

import type {
  ReferenceAssessment,
  ReferenceImpact,
  ReferenceSeverity,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import type { ReferenceReviewFinding } from "@/api/lib/document-review/reference-compare";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import {
  basisPerspective,
  basisPlaybook,
  basisReferences,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewDecision,
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-positions";
import type { VerdictTier } from "@/api/lib/workflow/verdict-tiers";

export type IssuesTableRow = {
  topic: string;
  impact: string;
  severity: string;
  draftPosition: string;
  precedentPosition: string;
  assessment: string;
  recommendation: string;
  proposedWording: string;
  decision: string;
};

/** Column order of the spreadsheet renderings; the Word table folds the
 *  short classification columns into the topic cell to fit a portrait page. */
export const ISSUES_TABLE_COLUMNS = [
  { key: "topic", header: "Topic" },
  { key: "impact", header: "Impact" },
  { key: "severity", header: "Severity" },
  { key: "draftPosition", header: "Draft position" },
  { key: "precedentPosition", header: "Precedent position" },
  { key: "assessment", header: "Assessment" },
  { key: "recommendation", header: "Recommendation" },
  { key: "proposedWording", header: "Proposed wording" },
  { key: "decision", header: "Decision" },
] as const satisfies readonly { key: keyof IssuesTableRow; header: string }[];

const IMPACT_LABEL = {
  favourable: "Favourable",
  unfavourable: "Unfavourable",
  neutral: "Neutral",
  unknown: "Unclear",
} as const satisfies Record<ReferenceImpact, string>;

const IMPACT_RANK = {
  unfavourable: 0,
  unknown: 1,
  neutral: 2,
  favourable: 3,
} as const satisfies Record<ReferenceImpact, number>;

const REFERENCE_SEVERITY_LABEL = {
  high: "High",
  medium: "Medium",
  low: "Low",
} as const satisfies Record<ReferenceSeverity, string>;

const REFERENCE_SEVERITY_RANK = {
  high: 0,
  medium: 1,
  low: 2,
} as const satisfies Record<ReferenceSeverity, number>;

const POSITION_SEVERITY_LABEL = {
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
  low: "Low",
} as const satisfies Record<PositionSeverity, string>;

const POSITION_SEVERITY_RANK = {
  blocker: 0,
  high: 0,
  medium: 1,
  low: 2,
} as const satisfies Record<PositionSeverity, number>;

const VERDICT_LABEL = {
  compliant: "Compliant",
  fallback: "Fallback",
  deviation: "Deviation",
  missing: "Missing",
  "not-applicable": "Not applicable",
} as const satisfies Record<VerdictTier, string>;

/** Deviations and gaps read like an unfavourable difference; the rest like a
 *  neutral one, so a combined run interleaves both check kinds sensibly. */
const VERDICT_RANK = {
  compliant: IMPACT_RANK.favourable,
  fallback: IMPACT_RANK.neutral,
  deviation: IMPACT_RANK.unfavourable,
  missing: IMPACT_RANK.unfavourable,
  "not-applicable": IMPACT_RANK.neutral,
} as const satisfies Record<VerdictTier, number>;

const ASSESSMENT_LABEL = {
  aligned: "Aligned",
  different: "Different",
  "missing-from-target": "Missing from the draft",
  "additional-in-target": "Only in the draft",
  "deal-specific": "Deal-specific",
  "not-comparable": "Not comparable",
} as const satisfies Record<ReferenceAssessment, string>;

const DECISION_LABEL = {
  open: "Open",
  accepted: "Accepted",
  dismissed: "Dismissed",
} as const satisfies Record<DocumentReviewDecision, string>;

const PERSPECTIVE_SIDE = {
  buyer: "the buyer",
  seller: "the seller",
  neutral: null,
} as const satisfies Record<ReviewPerspective, string | null>;

const PERSPECTIVE_LABEL = {
  buyer: "Reviewed for the buyer",
  seller: "Reviewed for the seller",
  neutral: "Reviewed from a neutral position",
} as const satisfies Record<ReviewPerspective, string>;

const INSUFFICIENT_EVIDENCE_LABEL = "Insufficient evidence to compare";
const PASSAGE_SEPARATOR = "\n\n";
const NO_VALUE = "";

const impactLabel = (
  impact: ReferenceImpact,
  perspective: ReviewPerspective,
): string => {
  const side = PERSPECTIVE_SIDE[perspective];
  if (side === null || impact === "neutral" || impact === "unknown") {
    return IMPACT_LABEL[impact];
  }
  return `${IMPACT_LABEL[impact]} to ${side}`;
};

export type IssuesTableFinding = {
  topicTitle: string;
  payload: DocumentReviewFindingPayload;
  decision: DocumentReviewDecision;
};

type RankedRow = { row: IssuesTableRow; rank: [number, number] };

type ReferenceRowArgs = {
  topicTitle: string;
  finding: ReferenceReviewFinding;
  decision: DocumentReviewDecision;
  perspective: ReviewPerspective;
  referenceNameByFieldId: ReadonlyMap<string, string>;
  labelReferences: boolean;
};

const referenceRow = ({
  topicTitle,
  finding,
  decision,
  perspective,
  referenceNameByFieldId,
  labelReferences,
}: ReferenceRowArgs): RankedRow => {
  const impact = finding.impact ?? "unknown";
  const severity = finding.severity ?? "medium";
  const precedentPassages: string[] = [];
  for (const group of finding.referenceCitations) {
    const name = referenceNameByFieldId.get(group.fileFieldId);
    const prefix = labelReferences && name !== undefined ? `[${name}] ` : "";
    for (const citation of group.citations) {
      precedentPassages.push(`${prefix}${citation.text}`);
    }
  }
  const explanation =
    finding.explanation.type === "comparison"
      ? finding.explanation.text
      : INSUFFICIENT_EVIDENCE_LABEL;
  return {
    rank: [IMPACT_RANK[impact], REFERENCE_SEVERITY_RANK[severity]],
    row: {
      topic: topicTitle,
      impact: impactLabel(impact, perspective),
      severity: REFERENCE_SEVERITY_LABEL[severity],
      draftPosition: finding.targetCitations
        .map((citation) => citation.text)
        .join(PASSAGE_SEPARATOR),
      precedentPosition: precedentPassages.join(PASSAGE_SEPARATOR),
      assessment: `${ASSESSMENT_LABEL[finding.assessment]}. ${explanation}`,
      recommendation: finding.recommendation ?? NO_VALUE,
      proposedWording: finding.fix?.text ?? NO_VALUE,
      decision: DECISION_LABEL[decision],
    },
  };
};

type PlaybookRowArgs = {
  topicTitle: string;
  finding: ReviewFinding;
  decision: DocumentReviewDecision;
  playbookName: string;
};

const playbookRow = ({
  topicTitle,
  finding,
  decision,
  playbookName,
}: PlaybookRowArgs): RankedRow => ({
  rank: [
    finding.verdict === null
      ? IMPACT_RANK.unknown
      : VERDICT_RANK[finding.verdict],
    POSITION_SEVERITY_RANK[finding.severity],
  ],
  row: {
    topic: topicTitle,
    impact:
      finding.verdict === null ? NO_VALUE : VERDICT_LABEL[finding.verdict],
    severity: POSITION_SEVERITY_LABEL[finding.severity],
    draftPosition: finding.extracted?.text ?? NO_VALUE,
    precedentPosition: `Playbook: ${playbookName}`,
    assessment: finding.rationale ?? NO_VALUE,
    recommendation: NO_VALUE,
    proposedWording: finding.fix?.text ?? NO_VALUE,
    decision: DECISION_LABEL[decision],
  },
});

type BuildIssuesTableRowsArgs = {
  basis: DocumentReviewRunBasis;
  findings: readonly IssuesTableFinding[];
};

/** Rows in reading order: findings that cut against the reviewer's side
 *  first, the worst of those on top; ties keep the run's own order. */
export const buildIssuesTableRows = ({
  basis,
  findings,
}: BuildIssuesTableRowsArgs): IssuesTableRow[] => {
  const references = basisReferences(basis);
  const referenceNameByFieldId = new Map(
    references.map((reference) => [reference.fileFieldId, reference.name]),
  );
  const perspective = basisPerspective(basis) ?? "neutral";
  const playbookName = basisPlaybook(basis)?.definitionSnapshot.name ?? "";
  const ranked: RankedRow[] = [];
  for (const { topicTitle, payload, decision } of findings) {
    switch (payload.checkKind) {
      case "reference":
        ranked.push(
          referenceRow({
            topicTitle,
            finding: payload.finding,
            decision,
            perspective,
            referenceNameByFieldId,
            labelReferences: references.length > 1,
          }),
        );
        break;
      case "playbook":
        ranked.push(
          playbookRow({
            topicTitle,
            finding: payload.finding,
            decision,
            playbookName,
          }),
        );
        break;
      default:
        payload satisfies never;
    }
  }
  const order = ranked.map((_, index) => index);
  order.sort((a, b) => {
    const left = ranked[a];
    const right = ranked[b];
    if (left === undefined || right === undefined) {
      return 0;
    }
    return (
      left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || a - b
    );
  });
  return order.flatMap((index) => {
    const entry = ranked[index];
    return entry === undefined ? [] : [entry.row];
  });
};

/** One line naming what the draft was measured against. */
export const describeIssuesTableBasis = (
  basis: DocumentReviewRunBasis,
): string => {
  const parts: string[] = [];
  const playbook = basisPlaybook(basis);
  if (playbook !== null) {
    parts.push(`Playbook: ${playbook.definitionSnapshot.name}`);
  }
  const references = basisReferences(basis);
  if (references.length > 0) {
    parts.push(
      `Precedent: ${references.map((reference) => reference.name).join(", ")}`,
    );
  }
  const perspective = basisPerspective(basis);
  if (perspective !== null) {
    parts.push(PERSPECTIVE_LABEL[perspective]);
  }
  return parts.join(" · ");
};

// Word rendering: the portrait text width (9360 twips) split over five
// columns. The classification columns ride inside the topic cell as a second
// line. Exported so a test can hold the split to the page width.
export const DOCX_TEXT_WIDTH = 9360;
export const DOCX_COLUMN_WIDTHS = [1700, 2150, 2150, 1900, 1460];
const DOCX_HEADER = [
  "Topic",
  "Draft position",
  "Precedent position",
  "Recommendation",
  "Proposed wording",
];
const HEADER_SHADING = { fill: { rgb: "E7E6E6" }, pattern: "clear" } as const;
const TOPIC_LINE_SEPARATOR = " · ";

const docxCell = (text: string): TableCellSpec =>
  text.length === 0
    ? NO_VALUE
    : {
        content: text
          .split(PASSAGE_SEPARATOR)
          .map((passage) => paragraph(passage)),
      };

const topicCell = (row: IssuesTableRow): TableCellSpec => {
  const classification = [row.impact, row.severity, row.decision]
    .filter((part) => part.length > 0)
    .join(TOPIC_LINE_SEPARATOR);
  return {
    content: [
      paragraph([run(row.topic, { bold: true })]),
      paragraph(classification),
    ],
  };
};

type RenderIssuesTableDocxArgs = {
  title: string;
  basisLine: string;
  rows: readonly IssuesTableRow[];
};

export const renderIssuesTableDocx = async ({
  title,
  basisLine,
  rows,
}: RenderIssuesTableDocxArgs): Promise<Buffer> => {
  const doc = createEmptyDocument({
    preset: createStellaStyleDocumentPreset(),
  });
  doc.package.document.content = [
    heading({ text: title, level: 1 }),
    paragraph(basisLine),
    table({
      header: DOCX_HEADER,
      headerShading: HEADER_SHADING,
      columnWidths: DOCX_COLUMN_WIDTHS,
      rows: rows.map((row) => [
        topicCell(row),
        docxCell(row.draftPosition),
        docxCell(row.precedentPosition),
        docxCell(row.recommendation),
        docxCell(row.proposedWording),
      ]),
    }),
    // A body must end with a paragraph (Word rejects a trailing table).
    paragraph(NO_VALUE),
  ];
  return Buffer.from(await createDocx(doc));
};
