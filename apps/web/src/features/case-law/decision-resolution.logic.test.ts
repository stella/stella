import { describe, expect, test } from "bun:test";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";

import { anchorAfterResolution } from "@/features/case-law/decision-resolution.logic";

const PREFIX = "reasons-syn-2-";

const ABSORBED = {
  type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
  absorbedDecisionId: "00000000-0000-4000-8000-000000000003",
  anchorPrefix: PREFIX,
} as const;

const paragraph = (anchorId: string) => ({
  id: `b-${anchorId}`,
  anchorId,
  type: "paragraph",
  inlines: [{ type: "text", text: anchorId }],
});

/** A ruling with its reasons composed in behind it. */
const JUDGMENT_AST = {
  version: 1,
  blocks: [
    paragraph("p-1"),
    paragraph(`${PREFIX}h-1`),
    paragraph(`${PREFIX}p-4`),
  ],
};

describe("anchorAfterResolution", () => {
  test("a direct read keeps the anchor it was given", () => {
    expect(
      anchorAfterResolution({
        resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
        documentAst: null,
        anchorId: "p-7",
      }),
    ).toBe("p-7");
  });

  test("an anchor into the absorbed reasons lands on the same block", () => {
    expect(
      anchorAfterResolution({
        resolution: ABSORBED,
        documentAst: JUDGMENT_AST,
        anchorId: "p-4",
      }),
    ).toBe(`${PREFIX}p-4`);
  });

  test("no anchor, or one the reasons do not hold, lands on their first block", () => {
    for (const anchorId of [undefined, "p-99"]) {
      expect(
        anchorAfterResolution({
          resolution: ABSORBED,
          documentAst: JUDGMENT_AST,
          anchorId,
        }),
      ).toBe(`${PREFIX}h-1`);
    }
  });

  test("a judgment held only as text names no anchor it cannot show", () => {
    // Composition appends the reasons to the text alone there, so no block
    // carries their prefix.
    for (const documentAst of [null, { version: 1, blocks: [] }]) {
      expect(
        anchorAfterResolution({
          resolution: ABSORBED,
          documentAst,
          anchorId: "p-4",
        }),
      ).toBeUndefined();
    }
  });
});
