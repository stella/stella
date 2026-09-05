/**
 * The issues table a reviewer hands to the other side or to the client: one
 * row per finding, read top to bottom in the order the results panel shows
 * them. Pure over the persisted run row and its findings, so the spreadsheet
 * and Word renderings cannot drift from each other.
 */

import { panic } from "better-result";

import { heading, paragraph, run, table } from "@stll/folio-core/server";
import type { TableCellSpec } from "@stll/folio-core/server";

import { arrayOrEmpty } from "@/api/lib/array";
import { perspectivePartyPhrase } from "@/api/lib/document-review/contract";
import type {
  ReferenceImpact,
  ReviewPerspective,
} from "@/api/lib/document-review/contract";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import type {
  DocumentReviewDecision,
  DocumentReviewFindingPayload,
  DocumentReviewRunBasis,
} from "@/api/lib/document-review/run-contract";
import {
  documentToDocx,
  stellaDocument,
} from "@/api/lib/docx-authoring/document";
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
  additional: "Only in the draft",
  "not-applicable": "Not applicable",
} as const satisfies Record<VerdictTier, string>;

/** Deviations and gaps read like an unfavourable difference; the rest like a
 *  neutral one, so a run interleaves both kinds of standard sensibly. */
const VERDICT_RANK = {
  compliant: IMPACT_RANK.favourable,
  fallback: IMPACT_RANK.neutral,
  deviation: IMPACT_RANK.unfavourable,
  missing: IMPACT_RANK.unfavourable,
  additional: IMPACT_RANK.neutral,
  "not-applicable": IMPACT_RANK.neutral,
} as const satisfies Record<VerdictTier, number>;

const DECISION_LABEL = {
  open: "Open",
  accepted: "Accepted",
  dismissed: "Dismissed",
} as const satisfies Record<DocumentReviewDecision, string>;

const NEUTRAL_PERSPECTIVE_LABEL = "Reviewed from a neutral position";

const INSUFFICIENT_EVIDENCE_LABEL = "Insufficient evidence to compare";
const PASSAGE_SEPARATOR = "\n\n";
const NO_VALUE = "";

const impactLabel = (
  impact: ReferenceImpact,
  perspective: ReviewPerspective,
): string => {
  if (
    perspective.type === "neutral" ||
    impact === "neutral" ||
    impact === "unknown"
  ) {
    return IMPACT_LABEL[impact];
  }
  return `${IMPACT_LABEL[impact]} to the ${perspective.role}`;
};

const perspectiveLabel = (perspective: ReviewPerspective): string => {
  switch (perspective.type) {
    case "party":
      return `Reviewed for ${perspectivePartyPhrase(perspective)}`;
    case "neutral":
      return NEUTRAL_PERSPECTIVE_LABEL;
    default:
      perspective satisfies never;
      return panic(`Unhandled perspective: ${String(perspective)}`);
  }
};

export type IssuesTableFinding = {
  positionTitle: string;
  payload: DocumentReviewFindingPayload;
  decision: DocumentReviewDecision;
};

type RankedRow = { row: IssuesTableRow; rank: [number, number] };

/** The precedent column: the standard's own passages when the position was
 *  derived from a document, otherwise the playbook that authored it. */
const precedentPosition = ({
  finding,
  playbookName,
  referenceNameByFieldId,
  passageTextById,
  labelReferences,
}: {
  finding: ReviewFinding;
  playbookName: string;
  referenceNameByFieldId: ReadonlyMap<string, string>;
  /** The words behind the cited passages, as far as the exporting reader may
   *  read them; a passage absent here is left out of the column. */
  passageTextById: ReadonlyMap<string, string>;
  labelReferences: boolean;
}): string => {
  switch (finding.standardSource) {
    case "reference": {
      const passages: string[] = [];
      for (const group of arrayOrEmpty(finding.referenceCitations)) {
        const name = referenceNameByFieldId.get(group.fileFieldId);
        const prefix =
          labelReferences && name !== undefined ? `[${name}] ` : "";
        for (const passage of group.passages) {
          const text = passageTextById.get(passage.id);
          if (text !== undefined) {
            passages.push(`${prefix}${text}`);
          }
        }
      }
      return passages.join(PASSAGE_SEPARATOR);
    }
    case "tiers":
      return playbookName.length === 0 ? NO_VALUE : `Playbook: ${playbookName}`;
    default:
      finding.standardSource satisfies never;
      return panic(
        `Unhandled standard source: ${String(finding.standardSource)}`,
      );
  }
};

/** The draft column: what the reviewed document says, from the passages the
 *  finding cited or the value it extracted. */
const draftPosition = (finding: ReviewFinding): string => {
  if (finding.citations.length > 0) {
    return finding.citations
      .map((citation) => citation.text)
      .join(PASSAGE_SEPARATOR);
  }
  return finding.extracted?.text ?? NO_VALUE;
};

/** The prose behind the verdict: a reference comparison states it outright, a
 *  tier match leaves it in the rationale. */
const explanationText = (finding: ReviewFinding): string | null => {
  const { explanation } = finding;
  if (explanation === undefined) {
    return finding.rationale;
  }
  switch (explanation.type) {
    case "comparison":
      return explanation.text;
    case "insufficient-evidence":
      return INSUFFICIENT_EVIDENCE_LABEL;
    default:
      explanation satisfies never;
      return panic(`Unhandled explanation: ${String(explanation)}`);
  }
};

const assessmentCell = (finding: ReviewFinding): string => {
  const verdict =
    finding.verdict === null ? NO_VALUE : VERDICT_LABEL[finding.verdict];
  const explanation = explanationText(finding);
  if (verdict.length === 0) {
    return explanation ?? NO_VALUE;
  }
  return explanation === null || explanation.length === 0
    ? verdict
    : `${verdict}. ${explanation}`;
};

/** The proposed wording, as the fix would write it. A parameter fix replaces
 *  one term, so the cell states the substitution rather than a paragraph. */
const proposedWording = (finding: ReviewFinding): string => {
  const { fix } = finding;
  if (fix === null) {
    return NO_VALUE;
  }
  switch (fix.kind) {
    case "replaceInBlock":
      return `${fix.find} → ${fix.replace}`;
    case "replaceBlock":
    case "insertAfterBlock":
      return fix.text;
    default:
      fix satisfies never;
      return panic(`Unhandled fix: ${String(fix)}`);
  }
};

type FindingRowArgs = {
  positionTitle: string;
  finding: ReviewFinding;
  decision: DocumentReviewDecision;
  perspective: ReviewPerspective;
  playbookName: string;
  referenceNameByFieldId: ReadonlyMap<string, string>;
  passageTextById: ReadonlyMap<string, string>;
  labelReferences: boolean;
};

const findingRow = ({
  positionTitle,
  finding,
  decision,
  perspective,
  playbookName,
  referenceNameByFieldId,
  passageTextById,
  labelReferences,
}: FindingRowArgs): RankedRow => {
  // The verdict ranks the row; a comparison's impact refines nothing the
  // verdict does not already say, so it is reported, not ranked on.
  const verdictRank =
    finding.verdict === null
      ? IMPACT_RANK.unknown
      : VERDICT_RANK[finding.verdict];
  const impact = finding.impact ?? "unknown";
  return {
    rank: [verdictRank, POSITION_SEVERITY_RANK[finding.severity]],
    row: {
      topic: positionTitle,
      impact: impactLabel(impact, perspective),
      severity: POSITION_SEVERITY_LABEL[finding.severity],
      draftPosition: draftPosition(finding),
      precedentPosition: precedentPosition({
        finding,
        playbookName,
        referenceNameByFieldId,
        passageTextById,
        labelReferences,
      }),
      assessment: assessmentCell(finding),
      recommendation: finding.recommendation ?? NO_VALUE,
      proposedWording: proposedWording(finding),
      decision: DECISION_LABEL[decision],
    },
  };
};

type BuildIssuesTableRowsArgs = {
  basis: DocumentReviewRunBasis;
  passageTextById: ReadonlyMap<string, string>;
  findings: readonly IssuesTableFinding[];
};

/** Rows in reading order: findings that cut against the reviewer's side
 *  first, the worst of those on top; ties keep the run's own order. */
export const buildIssuesTableRows = ({
  basis,
  passageTextById,
  findings,
}: BuildIssuesTableRowsArgs): IssuesTableRow[] => {
  const { references, perspective } = basis;
  const referenceNameByFieldId = new Map(
    references.map((reference) => [reference.fileFieldId, reference.name]),
  );
  const playbookName = basis.playbook.definitionSnapshot.name;
  const ranked = findings.map(({ positionTitle, payload, decision }) =>
    findingRow({
      positionTitle,
      finding: payload.finding,
      decision,
      perspective,
      playbookName,
      referenceNameByFieldId,
      passageTextById,
      labelReferences: references.length > 1,
    }),
  );
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
  const { playbook, references, perspective } = basis;
  const parts: string[] = [];
  // An ephemeral pin has no saved playbook to name; the references it was
  // built from say where the standard came from instead.
  if (playbook.provenance !== "ephemeral") {
    parts.push(`Playbook: ${playbook.definitionSnapshot.name}`);
  }
  if (references.length > 0) {
    parts.push(
      `Precedent: ${references.map((reference) => reference.name).join(", ")}`,
    );
  }
  parts.push(perspectiveLabel(perspective));
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
}: RenderIssuesTableDocxArgs): Promise<ArrayBuffer> => {
  const doc = stellaDocument();
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
  // A fresh copy owns a plain ArrayBuffer, which is what a Response body takes.
  return new Uint8Array(await documentToDocx(doc)).buffer;
};
