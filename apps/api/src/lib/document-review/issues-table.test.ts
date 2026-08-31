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
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import type { PositionSeverity } from "@/api/lib/workflow/playbook-positions";

const reference = (name: string, fileFieldId: string): PinnedReference => ({
  workspaceId: toSafeId<"workspace">("11111111-1111-4111-8111-111111111111"),
  workspaceName: "Precedent matter",
  entityId: toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
  fileFieldId: toSafeId<"field">(fileFieldId),
  entityVersionId: toSafeId<"entityVersion">(
    "33333333-3333-4333-8333-333333333333",
  ),
  contentSha256: "a".repeat(64),
  name,
});

const PRECEDENT_FIELD = "44444444-4444-4444-8444-444444444444";
const OTHER_FIELD = "55555555-5555-4555-8555-555555555555";
const PRECEDENT_PASSAGE_ID = "77777777-7777-4777-8777-777777777777";
const PRECEDENT_PASSAGE_TEXT = "Leakage is uncapped.";
const passageTextById = new Map([
  [PRECEDENT_PASSAGE_ID, PRECEDENT_PASSAGE_TEXT],
]);

const ephemeralPlaybook: PinnedPlaybook = {
  definitionId: null,
  versionId: null,
  provenance: "ephemeral",
  definitionSnapshot: {
    name: "Positions confirmed for this review",
    positions: { version: 3, items: [] },
  },
};

const basis: DocumentReviewRunBasis = {
  playbook: ephemeralPlaybook,
  references: [reference("Precedent SPA", PRECEDENT_FIELD)],
  perspective: { type: "party", role: "Buyer", name: null },
};

const referenceFinding = (
  positionTitle: string,
  overrides: {
    impact: "favourable" | "unfavourable" | "neutral" | "unknown";
    severity: PositionSeverity;
    verdict?: "deviation" | "compliant";
    decision?: IssuesTableFinding["decision"];
  },
): IssuesTableFinding => ({
  positionTitle,
  decision: overrides.decision ?? "open",
  payload: {
    finding: {
      positionId: "11111111-1111-4111-8111-11111111aaaa",
      issue: positionTitle,
      severity: overrides.severity,
      standardSource: "reference",
      verdict: overrides.verdict ?? "deviation",
      delta: { kind: "language" },
      extracted: null,
      consensus: "single",
      rationale: "The draft caps leakage.",
      explanation: { type: "comparison", text: "The draft caps leakage." },
      recommendation: "Remove the cap.",
      impact: overrides.impact,
      citations: [{ blockId: "p-1", text: "Leakage is capped." }],
      referenceCitations: [
        {
          fileFieldId: toSafeId<"field">(PRECEDENT_FIELD),
          passages: [{ id: PRECEDENT_PASSAGE_ID, blockId: "p-9" }],
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
      passageTextById,
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
      assessment: "Deviation. The draft caps leakage.",
      recommendation: "Remove the cap.",
      proposedWording: "No cap applies.",
      decision: "Accepted",
    });
  });

  // A parameter fix rewrites one term, so the cell states the substitution
  // rather than a paragraph the reviewer would have to diff by eye.
  test("states a parameter fix as the substitution it performs", () => {
    const finding = referenceFinding("Claims time bar", {
      impact: "unfavourable",
      severity: "high",
    });
    const [row] = buildIssuesTableRows({
      basis,
      passageTextById,
      findings: [
        {
          ...finding,
          payload: {
            finding: {
              ...finding.payload.finding,
              delta: {
                kind: "parameter",
                target: {
                  text: "12 months",
                  value: 12,
                  unit: "months",
                  citation: { blockId: "p-1", text: "within 12 months" },
                },
                standard: {
                  text: "6 months",
                  value: 6,
                  unit: "months",
                  citation: { blockId: "p-9", text: "within 6 months" },
                },
              },
              fix: {
                kind: "replaceInBlock",
                blockId: "p-1",
                find: "12 months",
                replace: "6 months",
              },
            },
          },
        },
      ],
    });
    expect(row?.proposedWording).toBe("12 months → 6 months");
  });

  test("orders findings by verdict first, worst on top, ties stable", () => {
    const rows = buildIssuesTableRows({
      basis,
      passageTextById,
      findings: [
        referenceFinding("Compliant", {
          impact: "favourable",
          severity: "high",
          verdict: "compliant",
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
      "Compliant",
    ]);
  });

  test("names the precedent per passage only when several were pinned", () => {
    const [row] = buildIssuesTableRows({
      basis: {
        playbook: ephemeralPlaybook,
        references: [
          reference("Precedent SPA", PRECEDENT_FIELD),
          reference("Second precedent SPA", OTHER_FIELD),
        ],
        perspective: { type: "neutral" },
      },
      passageTextById,
      findings: [
        referenceFinding("Leakage", { impact: "unknown", severity: "medium" }),
      ],
    });
    expect(row?.precedentPosition).toBe("[Precedent SPA] Leakage is uncapped.");
    expect(row?.impact).toBe("Unclear");
  });

  // A tier-graded position is measured against the playbook that authored it,
  // not against a document, so that is what the precedent column names.
  test("names the playbook for a tier-graded position", () => {
    const [row] = buildIssuesTableRows({
      basis: {
        playbook: {
          definitionId: toSafeId<"playbookDefinition">(
            "66666666-6666-4666-8666-666666666666",
          ),
          versionId: null,
          provenance: "draft",
          definitionSnapshot: {
            name: "SPA (buyer)",
            positions: { version: 3, items: [] },
          },
        },
        references: [],
        perspective: { type: "neutral" },
      },
      passageTextById,
      findings: [
        {
          positionTitle: "Governing law",
          decision: "open",
          payload: {
            finding: {
              positionId: "11111111-1111-4111-8111-11111111bbbb",
              issue: "Governing law",
              severity: "medium",
              standardSource: "tiers",
              verdict: "compliant",
              delta: { kind: "language" },
              extracted: {
                value: "England and Wales",
                text: "governed by English law",
              },
              rationale: "Matches the standard.",
              citations: [],
              fix: null,
            },
          },
        },
      ],
    });
    expect(row?.precedentPosition).toBe("Playbook: SPA (buyer)");
    expect(row?.draftPosition).toBe("governed by English law");
  });
});

describe("describeIssuesTableBasis", () => {
  test("names the precedent and the side, not an unsaved playbook", () => {
    expect(describeIssuesTableBasis(basis)).toBe(
      "Precedent: Precedent SPA · Reviewed for the Buyer",
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
      passageTextById,
      findings: [
        referenceFinding("Leakage", {
          impact: "unfavourable",
          severity: "high",
        }),
      ],
    });
    const docx = await renderIssuesTableDocx({
      title: "Draft SPA - review issues",
      basisLine: describeIssuesTableBasis(basis),
      rows,
    });
    // A ZIP container starts with the local file header signature "PK".
    expect(Array.from(new Uint8Array(docx, 0, 2))).toEqual([0x50, 0x4b]);
    expect(ISSUES_TABLE_COLUMNS).toHaveLength(9);
  });
});
