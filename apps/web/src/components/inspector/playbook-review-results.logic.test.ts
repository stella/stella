import { describe, expect, test } from "bun:test";

import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";
import type {
  PinnedPosition,
  RestoredReviewFinding,
} from "@/components/ai-suggestions/document-review-run.logic";
import {
  buildReviewResultItems,
  buildRunHistoryBasisSentence,
  buildRunSummarySentence,
  firstSentence,
  isReviewDeviation,
  isUndecidedDeviation,
  sortReviewResultItems,
  tallyReviewFlags,
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
    flags: [],
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

describe("counting the flags a reviewer set", () => {
  test("counts every flag, and names the ones nobody used", () => {
    const items = buildReviewResultItems({
      positions: [position("position-1"), position("position-2")],
      findings: [
        row(FIRST_ID, { flags: ["follow-up", "important"] }),
        row(SECOND_ID, { positionId: "position-2", flags: ["follow-up"] }),
      ],
    });

    expect(tallyReviewFlags(items)).toEqual({
      "needs-review": 0,
      important: 1,
      "follow-up": 2,
      contradiction: 0,
      verified: 0,
    });
  });
});

describe("the one caption sentence the card shows", () => {
  test("cuts at the first full stop", () => {
    expect(
      firstSentence(
        "The notice period is shorter than the standard. The standard asks for 60 days.",
      ),
    ).toBe("The notice period is shorter than the standard.");
  });

  test("keeps a single-sentence caption whole", () => {
    expect(firstSentence("The clause matches the standard")).toBe(
      "The clause matches the standard",
    );
  });

  test("does not cut at an abbreviation or an initial", () => {
    expect(
      firstSentence("Shorter than market, e.g. the Elixir SPA at 60 days."),
    ).toBe("Shorter than market, e.g. the Elixir SPA at 60 days.");
    expect(firstSentence("Signed by J. Novak on behalf of the seller.")).toBe(
      "Signed by J. Novak on behalf of the seller.",
    );
  });

  test("does not cut inside a decimal", () => {
    expect(firstSentence("The cap is 1.5x fees. The standard is 1x.")).toBe(
      "The cap is 1.5x fees.",
    );
  });
});

// The two phrases the caller resolves in its own locale; the sentence only
// has to place them.
const PROPOSED_FROM_REFERENCES = "positions proposed from the references";
const NO_SIDE = "no side";

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
        proposedFromReferencesLabel: PROPOSED_FROM_REFERENCES,
        sideLabel: "for the Purchaser",
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
        proposedFromReferencesLabel: PROPOSED_FROM_REFERENCES,
        sideLabel: NO_SIDE,
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

describe("what a history row says a run was measured against", () => {
  test("names the playbook a run was executed against", () => {
    expect(
      buildRunHistoryBasisSentence({
        playbookName: "Buy-side SPA",
        playbookProposed: false,
        proposedFromReferencesLabel: PROPOSED_FROM_REFERENCES,
        references: null,
        sideLabel: "for the Purchaser",
      }),
    ).toBe("Buy-side SPA · for the Purchaser");
  });

  test("names the references a run with no saved playbook compared against", () => {
    expect(
      buildRunHistoryBasisSentence({
        playbookName: "Positions confirmed for this review",
        playbookProposed: true,
        proposedFromReferencesLabel: PROPOSED_FROM_REFERENCES,
        references: "2 references",
        sideLabel: NO_SIDE,
      }),
    ).toBe("2 references · no side");
  });

  // A run can pin neither: an ephemeral list confirmed against a playbook
  // whose name was never saved. The row still has to say something.
  test("falls back to where the positions came from", () => {
    expect(
      buildRunHistoryBasisSentence({
        playbookName: null,
        playbookProposed: true,
        proposedFromReferencesLabel: PROPOSED_FROM_REFERENCES,
        references: null,
        sideLabel: NO_SIDE,
      }),
    ).toBe("positions proposed from the references · no side");
  });
});
