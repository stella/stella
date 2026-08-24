import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  buildIssuesTableRows,
  describeIssuesTableBasis,
  DOCX_COLUMN_WIDTHS,
  DOCX_TEXT_WIDTH,
  ISSUES_TABLE_COLUMNS,
  renderIssuesTableDocx,
} from "@/api/lib/document-review/issues-table";
import type { IssuesTableFinding } from "@/api/lib/document-review/issues-table";
import type {
  DocumentReviewRunBasis,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";

const reference = (name: string, fileFieldId: string): PinnedReference => ({
  workspaceId: toSafeId<"workspace">("11111111-1111-4111-8111-111111111111"),
  workspaceName: "Project Elixir",
  entityId: toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
  fileFieldId: toSafeId<"field">(fileFieldId),
  entityVersionId: toSafeId<"entityVersion">(
    "33333333-3333-4333-8333-333333333333",
  ),
  contentSha256: "a".repeat(64),
  name,
});

const ELIXIR_FIELD = "44444444-4444-4444-8444-444444444444";
const OTHER_FIELD = "55555555-5555-4555-8555-555555555555";

const basis: DocumentReviewRunBasis = {
  type: "references",
  references: [reference("Elixir SPA", ELIXIR_FIELD)],
  perspective: { type: "party", role: "Buyer", name: null },
};

const referenceFinding = (
  topicTitle: string,
  overrides: {
    impact: "favourable" | "unfavourable" | "neutral" | "unknown";
    severity: "high" | "medium" | "low";
    decision?: IssuesTableFinding["decision"];
  },
): IssuesTableFinding => ({
  topicTitle,
  decision: overrides.decision ?? "open",
  payload: {
    checkKind: "reference",
    finding: {
      findingId: "f-1",
      topicId: "t-1",
      issue: topicTitle,
      assessment: "different",
      consensus: "single",
      explanation: { type: "comparison", text: "The draft caps leakage." },
      recommendation: "Remove the cap.",
      impact: overrides.impact,
      severity: overrides.severity,
      targetCitations: [{ blockId: "p-1", text: "Leakage is capped." }],
      referenceCitations: [
        {
          fileFieldId: toSafeId<"field">(ELIXIR_FIELD),
          citations: [{ blockId: "p-9", text: "Leakage is uncapped." }],
        },
      ],
      fix: { kind: "replaceBlock", blockId: "p-1", text: "No cap applies." },
    },
  },
});

describe("buildIssuesTableRows", () => {
  test("labels impact for the reviewed side and fills every column", () => {
    const [row] = buildIssuesTableRows({
      basis,
      findings: [
        referenceFinding("Leakage", {
          impact: "unfavourable",
          severity: "high",
          decision: "accepted",
        }),
      ],
    });
    expect(row).toEqual({
      topic: "Leakage",
      impact: "Unfavourable to the Buyer",
      severity: "High",
      draftPosition: "Leakage is capped.",
      precedentPosition: "Leakage is uncapped.",
      assessment: "Different. The draft caps leakage.",
      recommendation: "Remove the cap.",
      proposedWording: "No cap applies.",
      decision: "Accepted",
    });
  });

  test("orders findings against the side first, worst on top, ties stable", () => {
    const rows = buildIssuesTableRows({
      basis,
      findings: [
        referenceFinding("Favourable", {
          impact: "favourable",
          severity: "high",
        }),
        referenceFinding("Low", { impact: "unfavourable", severity: "low" }),
        referenceFinding("High A", {
          impact: "unfavourable",
          severity: "high",
        }),
        referenceFinding("High B", {
          impact: "unfavourable",
          severity: "high",
        }),
      ],
    });
    expect(rows.map((row) => row.topic)).toEqual([
      "High A",
      "High B",
      "Low",
      "Favourable",
    ]);
  });

  test("names the precedent per passage only when several were pinned", () => {
    const [row] = buildIssuesTableRows({
      basis: {
        type: "references",
        references: [
          reference("Elixir SPA", ELIXIR_FIELD),
          reference("Orion SPA", OTHER_FIELD),
        ],
        perspective: { type: "neutral" },
      },
      findings: [
        referenceFinding("Leakage", { impact: "unknown", severity: "medium" }),
      ],
    });
    expect(row?.precedentPosition).toBe("[Elixir SPA] Leakage is uncapped.");
    expect(row?.impact).toBe("Unclear");
  });
});

describe("describeIssuesTableBasis", () => {
  test("names the precedent and the side", () => {
    expect(describeIssuesTableBasis(basis)).toBe(
      "Precedent: Elixir SPA · Reviewed for the Buyer",
    );
  });
});

describe("renderIssuesTableDocx", () => {
  test("the column split fills the page width", () => {
    expect(DOCX_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0)).toBe(
      DOCX_TEXT_WIDTH,
    );
  });

  test("writes a Word package", async () => {
    const rows = buildIssuesTableRows({
      basis,
      findings: [
        referenceFinding("Leakage", {
          impact: "unfavourable",
          severity: "high",
        }),
      ],
    });
    const docx = await renderIssuesTableDocx({
      title: "Fusion SPA - review issues",
      basisLine: describeIssuesTableBasis(basis),
      rows,
    });
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(ISSUES_TABLE_COLUMNS).toHaveLength(9);
  });
});
