import { describe, expect, test } from "bun:test";

import {
  DECISION_ANCHOR_REDIRECT,
  DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
  DECISION_ANCHOR_RESOLUTION,
} from "@stll/api-contract/case-law-anchor-redirects";

import {
  anchorRedirectBatches,
  HELD_ANCHOR_STATE,
  heldAnchorTarget,
  resolveHeldDecisionAnchor,
} from "./decision-anchor-resolution.logic";

const stableDocument = new Set(["n12", "n13", "x0a1b2c3d4e"]);

describe("held decision anchors", () => {
  test("an anchor the shown document holds is current and needs no read", () => {
    expect(anchorRedirectBatches(["n12"], stableDocument)).toEqual([]);
    expect(
      resolveHeldDecisionAnchor({
        anchor: "n12",
        currentAnchors: stableDocument,
        reads: [],
      }),
    ).toEqual({ type: DECISION_ANCHOR_RESOLUTION.CURRENT, anchorId: "n12" });
  });

  test("a legacy decision not yet rewritten keeps its positional anchors", () => {
    const legacy = new Set(["p-1", "p-2", "h-3"]);
    expect(anchorRedirectBatches(["p-2", "h-3"], legacy)).toEqual([]);
    expect(
      resolveHeldDecisionAnchor({
        anchor: "p-2",
        currentAnchors: legacy,
        reads: [],
      }),
    ).toEqual({ type: DECISION_ANCHOR_RESOLUTION.CURRENT, anchorId: "p-2" });
  });

  test("a moved anchor follows its redirect into the shown document", () => {
    const held = resolveHeldDecisionAnchor({
      anchor: "p-12",
      currentAnchors: stableDocument,
      reads: [
        {
          type: "answered",
          items: [
            {
              anchor: "p-12",
              redirect: {
                type: DECISION_ANCHOR_REDIRECT.MOVED,
                anchorId: "n13",
              },
            },
          ],
        },
      ],
    });
    expect(held).toEqual({
      type: DECISION_ANCHOR_RESOLUTION.MOVED,
      anchorId: "n13",
    });
    expect(heldAnchorTarget(held)).toBe("n13");
  });

  test("a redirect target the shown document lacks is gone, not guessed", () => {
    expect(
      resolveHeldDecisionAnchor({
        anchor: "p-12",
        currentAnchors: stableDocument,
        reads: [
          {
            type: "answered",
            items: [
              {
                anchor: "p-12",
                redirect: {
                  type: DECISION_ANCHOR_REDIRECT.MOVED,
                  anchorId: "n99",
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({ type: DECISION_ANCHOR_RESOLUTION.GONE });
  });

  test("a dropped or never-held anchor is gone", () => {
    for (const redirect of [
      { type: DECISION_ANCHOR_REDIRECT.GONE },
      { type: DECISION_ANCHOR_REDIRECT.NOT_REDIRECTED },
    ] as const) {
      const held = resolveHeldDecisionAnchor({
        anchor: "p-40",
        currentAnchors: stableDocument,
        reads: [{ type: "answered", items: [{ anchor: "p-40", redirect }] }],
      });
      expect(held).toEqual({ type: DECISION_ANCHOR_RESOLUTION.GONE });
      expect(heldAnchorTarget(held)).toBeUndefined();
    }
  });

  test("a pending or failed read is told apart from an answer", () => {
    expect(
      resolveHeldDecisionAnchor({
        anchor: "p-1",
        currentAnchors: stableDocument,
        reads: [{ type: "pending", anchors: ["p-1"] }],
      }),
    ).toEqual({ type: HELD_ANCHOR_STATE.PENDING });
    expect(
      resolveHeldDecisionAnchor({
        anchor: "p-1",
        currentAnchors: stableDocument,
        reads: [{ type: "failed", anchors: ["p-1"] }],
      }),
    ).toEqual({ type: HELD_ANCHOR_STATE.UNAVAILABLE });
  });

  test("unknown anchors are de-duplicated and split into accepted batches", () => {
    const anchors = Array.from(
      { length: DECISION_ANCHOR_REDIRECT_MAX_ANCHORS + 3 },
      (_, index) => `p-${String(index)}`,
    );
    const batches = anchorRedirectBatches(
      [...anchors, "p-0", "n12"],
      stableDocument,
    );
    expect(batches.map((batch) => batch.length)).toEqual([
      DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
      3,
    ]);
    expect(batches.flat()).toEqual(anchors);
  });
});
