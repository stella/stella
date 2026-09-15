import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { selectStatuteProvisions } from "@/api/handlers/chat/active-statute-selection.logic";

const heading = (anchorId: string, text: string): Block => ({
  anchorId,
  id: `h-${anchorId}`,
  inlines: [{ text, type: "text" }],
  level: 2,
  plainText: text,
  type: "heading",
});

const paragraph = (anchorId: string, text: string): Block => ({
  anchorId,
  id: `p-${anchorId}`,
  inlines: [{ text, type: "text" }],
  plainText: text,
  type: "paragraph",
});

/** An act of `count` provisions, each one heading plus one body paragraph. */
const act = (count: number, bodyChars: number): Block[] =>
  Array.from({ length: count }).flatMap((_unused, index) => {
    const anchor = `par_${String(index + 1)}`;
    return [
      heading(anchor, `Section ${String(index + 1)}`),
      paragraph(`${anchor}-odst_1`, "w".repeat(bodyChars)),
    ];
  });

const designationCost = (anchorId: string): number =>
  `[${anchorId}]`.length + 2;

describe("statute provision selection", () => {
  test("files a subdivision under the provision that owns it", () => {
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: [],
      blocks: [
        heading("par_1", "Section 1"),
        paragraph("par_1-odst_1", "First subsection"),
        paragraph("par_1-odst_1-pism_a", "Letter a"),
        heading("par_2", "Section 2"),
      ],
      maxChars: 10_000,
    });

    expect(selection.provisions.map(({ anchorId }) => anchorId)).toEqual([
      "par_1",
      "par_2",
    ]);
    expect(selection.provisions.at(0)?.text).toContain("[par_1-odst_1-pism_a]");
  });

  test("keeps sibling sections apart when their anchors share a prefix", () => {
    // `sec-1` and `sec-2` are two sections, not one: a split on the anchor
    // path would merge them and hand the model one oversized provision.
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: [],
      blocks: [
        heading("sec-1", "Section 1"),
        paragraph("sec-1-1", "First rule."),
        heading("sec-2", "Section 2"),
        paragraph("sec-2-1", "Second rule."),
      ],
      maxChars: 10_000,
    });

    expect(selection.provisions.map(({ anchorId }) => anchorId)).toEqual([
      "sec-1",
      "sec-2",
    ]);
  });

  test("selects a marked provision by the block its mark sits on", () => {
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["sec-2-1"],
      blocks: [
        heading("sec-1", "Section 1"),
        paragraph("sec-1-1", "x".repeat(400)),
        heading("sec-2", "Section 2"),
        paragraph("sec-2-1", "Second rule."),
      ],
      maxChars: 120,
    });

    expect(
      selection.provisions.find(({ annotated }) => annotated)?.anchorId,
    ).toBe("sec-2");
  });

  test("ignores a mark whose block is gone from this consolidation", () => {
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_404-odst_1"],
      blocks: act(2, 20),
      maxChars: 10_000,
    });

    expect(selection.provisions.every(({ annotated }) => !annotated)).toBe(
      true,
    );
  });

  test("reads the act whole when it fits, and says so", () => {
    const blocks = act(4, 100);
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: [],
      blocks,
      maxChars: 10_000,
    });

    expect(selection.partial).toBe(false);
    expect(selection.omittedProvisionCount).toBe(0);
    expect(selection.provisions).toHaveLength(4);
  });

  test("takes a prefix of the act when it does not, and flags the cut", () => {
    const blocks = act(40, 400);
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: [],
      blocks,
      maxChars: 2000,
    });

    expect(selection.partial).toBe(true);
    expect(selection.omittedProvisionCount).toBeGreaterThan(0);
    expect(selection.provisions.at(0)?.anchorId).toBe("par_1");
    // A prefix, not a sample: what it kept is the act's opening run.
    expect(selection.provisions.map(({ anchorId }) => anchorId)).toEqual(
      Array.from({ length: selection.provisions.length }).map(
        (_unused, index) => `par_${String(index + 1)}`,
      ),
    );
  });

  test("keeps a marked provision the prefix would never have reached", () => {
    const blocks = act(40, 400);
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_37-odst_1"],
      blocks,
      maxChars: 2000,
    });

    const marked = selection.provisions.find(
      ({ anchorId }) => anchorId === "par_37",
    );
    expect(marked?.annotated).toBe(true);
    expect(marked?.text).toContain("[par_37-odst_1]");
  });

  test("a marked provision too large for the budget is clipped, not dropped", () => {
    const blocks = act(3, 5000);
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_2"],
      blocks,
      maxChars: 500,
    });

    const marked = selection.provisions.find(
      ({ anchorId }) => anchorId === "par_2",
    );
    expect(marked?.clipped).toBe(true);
    expect(selection.partial).toBe(true);
    expect(selection.text.length).toBeLessThanOrEqual(500);
  });

  test("clips between blocks so no passage carries a half-written anchor", () => {
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_90"],
      blocks: [
        heading("par_90", "S"),
        paragraph("par_90-odst_1", "x".repeat(200)),
        paragraph("par_90-odst_2", "y".repeat(200)),
      ],
      maxChars: 40,
    });

    const marked = selection.provisions.at(0);
    expect(marked?.clipped).toBe(true);
    // The heading fits; neither subsection does, and neither leaves a
    // fragment of `[par_90-odst_1]` behind.
    expect(marked?.text).toBe("[par_90] S");
  });

  test("a marked provision with no room for wording keeps its designation", () => {
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_2-odst_1"],
      blocks: act(3, 400),
      maxChars: designationCost("par_2"),
    });

    expect(selection.provisions.map(({ text }) => text)).toEqual(["[par_2]"]);
    expect(selection.partial).toBe(true);
  });

  test("marked provisions share the budget rather than starving each other", () => {
    const blocks = [
      heading("par_1", "Section 1"),
      paragraph("par_1-odst_1", "s".repeat(50)),
      heading("par_2", "Section 2"),
      ...Array.from({ length: 10 }).map((_unused, index) =>
        paragraph(`par_2-odst_${String(index + 1)}`, "l".repeat(30)),
      ),
    ];
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: ["par_1", "par_2"],
      blocks,
      maxChars: 400,
    });

    const short = selection.provisions.find(
      ({ anchorId }) => anchorId === "par_1",
    );
    const long = selection.provisions.find(
      ({ anchorId }) => anchorId === "par_2",
    );
    // The short one is whole, and its leftover raised the long one's share
    // past the 200 characters an equal split would have given it.
    expect(short?.clipped).toBe(false);
    expect(long?.text.length).toBeGreaterThan(200);
    expect(selection.text.length).toBeLessThanOrEqual(400);
  });
});

/**
 * The selection's contract over the whole input class: act size, provision
 * size, how much the reader marked, and the budget. These are what the prompt
 * builder relies on, so they are asserted per case rather than illustrated by
 * one example.
 */
describe("statute provision selection invariants", () => {
  const CASES = [
    { bodyChars: 0, marks: [], provisions: 0 },
    { bodyChars: 1, marks: [], provisions: 1 },
    { bodyChars: 10, marks: ["par_2"], provisions: 3 },
    { bodyChars: 250, marks: ["par_9-odst_1", "par_12"], provisions: 12 },
    { bodyChars: 900, marks: [], provisions: 60 },
    { bodyChars: 900, marks: ["par_60"], provisions: 60 },
    {
      bodyChars: 4000,
      marks: Array.from({ length: 40 }).map(
        (_unused, index) => `par_${String(index + 1)}-odst_1`,
      ),
      provisions: 40,
    },
  ] as const satisfies readonly {
    bodyChars: number;
    marks: readonly string[];
    provisions: number;
  }[];
  const BUDGETS = [0, 1, 37, 500, 4000, 24_000, 1_000_000] as const;

  test("bounds the rendered block for an act of blank provisions", () => {
    // Every provision renders as its bare designation, which costs characters
    // the wording budget alone would not have counted.
    const blocks = Array.from({ length: 5000 }).flatMap((_unused, index) => [
      heading(`par_${String(index + 1)}`, "   "),
      paragraph(`par_${String(index + 1)}-odst_1`, "  "),
    ]);
    const selection = selectStatuteProvisions({
      annotatedAnchorIds: [],
      blocks,
      maxChars: 1000,
    });

    expect(selection.text.length).toBeLessThanOrEqual(1000);
    expect(selection.partial).toBe(true);
  });

  for (const { bodyChars, marks, provisions } of CASES) {
    for (const maxChars of BUDGETS) {
      test(`${String(provisions)} provisions of ${String(bodyChars)} chars, ${String(marks.length)} marked, budget ${String(maxChars)}`, () => {
        const blocks = act(provisions, bodyChars);
        const selection = selectStatuteProvisions({
          annotatedAnchorIds: marks,
          blocks,
          maxChars,
        });
        const kept = selection.provisions.map(({ anchorId }) => anchorId);
        const whole = selectStatuteProvisions({
          annotatedAnchorIds: marks,
          blocks,
          maxChars: Number.MAX_SAFE_INTEGER,
        });

        // The budget bounds the RENDERED block, separators and bare
        // designations included, so nothing downstream ever has to cut it.
        expect(selection.text.length).toBeLessThanOrEqual(maxChars);
        expect(selection.text).toBe(
          selection.provisions.map(({ text }) => text).join("\n\n"),
        );

        // A marked provision survives as long as the budget admits the
        // designations of all of them; its wording may not.
        const markedAnchors = whole.provisions
          .filter(({ annotated }) => annotated)
          .map(({ anchorId }) => anchorId);
        const designations = markedAnchors.reduce(
          (sum, anchorId) => sum + designationCost(anchorId),
          0,
        );
        if (maxChars >= designations) {
          expect(kept).toEqual(expect.arrayContaining(markedAnchors));
        }

        // `partial` is exactly "the model is not reading the whole act".
        expect(selection.partial).toBe(
          selection.omittedProvisionCount > 0 || selection.text !== whole.text,
        );
        expect(whole.partial).toBe(false);

        // A clip lands between blocks, so what a provision kept is a whole
        // prefix of its passages rather than a cut inside one.
        const wholeByAnchor = new Map(
          whole.provisions.map(({ anchorId, text }) => [anchorId, text]),
        );
        for (const { anchorId, text } of selection.provisions) {
          const full = wholeByAnchor.get(anchorId) ?? "";
          expect(
            text === `[${anchorId}]` ||
              (full.startsWith(text) &&
                (text === full || full.slice(text.length).startsWith("\n\n"))),
          ).toBe(true);
        }

        // Document order, whichever pass chose a provision.
        const documentOrder = whole.provisions.map(({ anchorId }) => anchorId);
        expect(kept).toEqual(
          documentOrder.filter((anchor) => kept.includes(anchor)),
        );
      });
    }
  }
});
