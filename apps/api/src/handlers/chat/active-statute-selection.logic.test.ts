import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";
import { provisionHeadingAnchor } from "@stll/legal-ast/provision-preview";

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

const selectedText = (
  selection: ReturnType<typeof selectStatuteProvisions>,
): string => selection.provisions.map(({ text }) => text).join("");

const totalChars = (
  selection: ReturnType<typeof selectStatuteProvisions>,
): number =>
  selection.provisions.reduce((sum, { text }) => sum + text.length, 0);

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
    expect(totalChars(selection)).toBeLessThanOrEqual(500);
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
    expect(totalChars(selection)).toBeLessThanOrEqual(400);
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

        // The budget is a ceiling, whatever the act and the marks look like.
        expect(totalChars(selection)).toBeLessThanOrEqual(maxChars);

        // A marked provision is never dropped: its designation survives even
        // when its wording does not.
        for (const mark of marks) {
          expect(kept).toContain(provisionHeadingAnchor(mark));
        }

        // `partial` is exactly "the model is not reading the whole act".
        const whole = selectStatuteProvisions({
          annotatedAnchorIds: marks,
          blocks,
          maxChars: Number.MAX_SAFE_INTEGER,
        });
        expect(selection.partial).toBe(
          selection.omittedProvisionCount > 0 ||
            selectedText(selection) !== selectedText(whole),
        );
        expect(whole.partial).toBe(false);

        // A clip lands between blocks, so what a provision kept is a whole
        // prefix of its passages rather than a cut inside one.
        const wholeByAnchor = new Map(
          whole.provisions.map(({ anchorId, text }) => [anchorId, text]),
        );
        for (const { anchorId, text } of selection.provisions) {
          const full = wholeByAnchor.get(anchorId) ?? "";
          expect(full.startsWith(text)).toBe(true);
          expect(
            text.length === 0 ||
              text === full ||
              full.slice(text.length).startsWith("\n\n"),
          ).toBe(true);
        }

        // Document order, whichever pass chose a provision.
        const documentOrder = blocks
          .map(({ anchorId }) => provisionHeadingAnchor(anchorId))
          .filter((anchor, index, all) => all.indexOf(anchor) === index);
        expect(kept).toEqual(
          documentOrder.filter((anchor) => kept.includes(anchor)),
        );
      });
    }
  }
});
