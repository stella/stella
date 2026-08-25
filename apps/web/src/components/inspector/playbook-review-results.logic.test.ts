import { describe, expect, test } from "bun:test";

import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";
import type {
  PinnedPosition,
  RestoredReviewFinding,
} from "@/components/ai-suggestions/document-review-run.logic";
import {
  buildReviewResultItems,
  buildRunSummarySentence,
  isReviewDeviation,
  isUndecidedDeviation,
  sortReviewResultItems,
} from "@/components/inspector/playbook-review-results.logic";
import { toSafeId } from "@/lib/safe-id";

const position = (
  sourceId: string,
  issue: string = "Notice period",
): PinnedPosition => ({
  mode: "graded",
  sourceId,
  issue,
  severity: "medium",
  standard: {
    source: "tiers",
    tiers: {
      acceptable: { rules: [] },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: { mode: "auto" },
  enabled: true,
});

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  positionId: "position-1",
  issue: "Notice period",
  severity: "medium",
  standardSource: "tiers",
  verdict: "compliant",
  delta: { kind: "language" },
  extracted: null,
  rationale: null,
  citations: [],
  fix: null,
  ...overrides,
});

const row = (
  id: string,
  overrides: Omit<Partial<RestoredReviewFinding>, "finding"> & {
    finding?: Partial<ReviewFinding>;
  } = {},
): RestoredReviewFinding => {
  const { finding: findingOverrides, ...rest } = overrides;
  const positionId = rest.positionId ?? "position-1";
  return {
    id: toSafeId<"documentReviewFinding">(id),
    positionId,
    title: "Notice period",
    decision: "open",
    applicationStatus: "pending",
    suggestionId: null,
    ...rest,
    finding: finding({ positionId, ...findingOverrides }),
  };
};

const FIRST_ID = "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e70";
const SECOND_ID = "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e71";
const THIRD_ID = "0198f2c4-1e55-7c31-9a10-3b1d2f4c5e72";

describe("joining findings to the positions they judged", () => {
  test("carries each position and its place in the confirmed list", () => {
    const items = buildReviewResultItems({
      positions: [position("position-1"), position("position-2")],
      findings: [row(SECOND_ID, { positionId: "position-2" })],
    });

    expect(items).toHaveLength(1);
    expect(items.at(0)?.position?.sourceId).toBe("position-2");
    expect(items.at(0)?.order).toBe(1);
  });

  test("a finding whose position left the snapshot still renders, sorted last", () => {
    const items = buildReviewResultItems({
      positions: [position("position-1")],
      findings: [row(FIRST_ID, { positionId: "gone" })],
    });

    expect(items.at(0)?.position).toBeNull();
    expect(items.at(0)?.order).toBe(1);
  });
});

describe("what counts as a deviation", () => {
  test("a flagged verdict is one", () => {
    const [item] = buildReviewResultItems({
      positions: [position("position-1")],
      findings: [row(FIRST_ID, { finding: { verdict: "deviation" } })],
    });
    expect(item !== undefined && isReviewDeviation(item)).toBe(true);
  });

  test("an unfavourable impact is one whatever the verdict says", () => {
    const [item] = buildReviewResultItems({
      positions: [position("position-1")],
      findings: [
        row(FIRST_ID, {
          finding: { verdict: "additional", impact: "unfavourable" },
        }),
      ],
    });
    expect(item !== undefined && isReviewDeviation(item)).toBe(true);
  });

  test("a compliant finding with no adverse impact is not", () => {
    const [item] = buildReviewResultItems({
      positions: [position("position-1")],
      findings: [row(FIRST_ID, { finding: { impact: "favourable" } })],
    });
    expect(item !== undefined && isReviewDeviation(item)).toBe(false);
  });

  test("deciding a deviation takes it off the filter without changing it", () => {
    const [item] = buildReviewResultItems({
      positions: [position("position-1")],
      findings: [
        row(FIRST_ID, {
          decision: "dismissed",
          finding: { verdict: "deviation" },
        }),
      ],
    });
    expect(item !== undefined && isReviewDeviation(item)).toBe(true);
    expect(item !== undefined && isUndecidedDeviation(item)).toBe(false);
  });
});

describe("what the run says it read", () => {
  const reference = {
    workspaceId: "workspace-1",
    workspaceName: null,
    entityId: "entity-1",
    fileFieldId: "field-1",
    name: "Elixir SPA",
    fileName: "elixir.docx",
  };

  test("names the document, its version, the references, the playbook and the side", () => {
    expect(
      buildRunSummarySentence({
        targetName: "Fusion SPA",
        targetVersionNumber: 4,
        references: [reference],
        playbookName: "SPA (buyer)",
        playbookProposed: false,
        perspective: { type: "party", role: "Purchaser", name: null },
      }),
    ).toBe("Fusion SPA v4 · Elixir SPA · SPA (buyer) · for the Purchaser");
  });

  test("says where an unsaved run's positions came from, and that no side was chosen", () => {
    expect(
      buildRunSummarySentence({
        targetName: "Fusion SPA",
        targetVersionNumber: null,
        references: [reference],
        playbookName: "Positions confirmed for this review",
        playbookProposed: true,
        perspective: { type: "neutral" },
      }),
    ).toBe(
      "Fusion SPA · Elixir SPA · positions proposed from the references · no side",
    );
  });
});

describe("the order the list is read in", () => {
  test("sorts by severity, then by the confirmed position order", () => {
    const items = buildReviewResultItems({
      positions: [
        position("position-1"),
        position("position-2"),
        position("position-3"),
      ],
      findings: [
        row(FIRST_ID, {
          positionId: "position-1",
          finding: { severity: "low" },
        }),
        row(SECOND_ID, {
          positionId: "position-2",
          finding: { severity: "blocker" },
        }),
        row(THIRD_ID, {
          positionId: "position-3",
          finding: { severity: "blocker" },
        }),
      ],
    });

    expect(sortReviewResultItems(items).map((item) => item.positionId)).toEqual(
      ["position-2", "position-3", "position-1"],
    );
  });
});
