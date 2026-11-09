/**
 * What must hold for any decision, numbered or not.
 *
 * - Faithful: a numbered paragraph's text is the printed text with only the
 *   marker removed, and the marker states exactly the stored number.
 * - Structure-preserving: the same blocks, ids and anchors, in order.
 * - Idempotent: a second pass changes nothing — a re-parse or a replay of a
 *   numbered decision cannot number its nested lists.
 * - Sound: stored numbers come from markers alone, and an unnumbered
 *   outcome leaves the blocks exactly as they were.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { extractCourtParagraphNumbers } from "./court-paragraph-numbers.js";
import type { Block, ParagraphBlock } from "./document-ast.js";

const MARKERS = {
  bracket: (number: number, gap = " ") => `[${String(number)}]${gap}`,
  dot: (number: number, gap = "\t") => `${String(number)}.${gap}`,
  paren: (number: number, gap = " ") => `${String(number)})${gap}`,
} as const;

/**
 * The horizontal space a publisher leaves after a marker: one space, a tab,
 * a no-break space, or a run of them. A run must be judged as a whole — a
 * date or a lowercase point after two spaces is still not a paragraph.
 */
const gap = fc
  .array(fc.constantFrom(" ", "\t", "\u00a0"), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join(""));

const words = fc
  .array(
    fc.constantFrom(
      "Soud",
      "žalobce",
      "dovolání",
      "odst. 2",
      "bod 12",
      "§ 237",
      "zamítl",
      "12. 3. 2020",
      "(viz [3])",
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.join(" "));

type Draft = {
  readonly role: ParagraphBlock["role"];
  readonly marker: keyof typeof MARKERS | null;
  readonly number: number;
  readonly gap: string;
  readonly text: string;
};

const draft: fc.Arbitrary<Draft> = fc.record({
  role: fc.constantFrom(undefined, undefined, "holding", "dissent", "closing"),
  marker: fc.constantFrom(null, "bracket", "dot", "dot", "paren"),
  number: fc.integer({ min: 1, max: 40 }),
  gap,
  text: words,
});

/** Decisions that mostly count up, with lists, skips and stray markers. */
const decision = fc
  .tuple(fc.array(draft, { maxLength: 40 }), fc.boolean())
  .map(([drafts, counting]): Block[] => {
    let next = 1;
    return drafts.map((item, index) => {
      const number = counting && item.marker !== null ? next++ : item.number;
      const plainText =
        item.marker === null
          ? item.text
          : `${MARKERS[item.marker](number, item.gap)}${item.text}`;
      return {
        id: `b${String(index)}`,
        anchorId: `p-${String(index)}`,
        type: "paragraph",
        role: item.role,
        inlines: [{ type: "text", text: plainText }],
        plainText,
      };
    });
  });

const MARKER_PREFIX =
  /^(?:\[(\d+)\][ \t\u00a0]*|(\d+)\.[ \t\u00a0]+|(\d+)\)[ \t\u00a0]+)/u;

/**
 * A court's marker, judged by what follows the whole run of space: never a
 * digit (a date) or a lowercase letter (a point of a list).
 */
const STYLE_MARKER = {
  bracket: /^\[(?<n>\d+)\][ \t\u00a0]*/u,
  dot: /^(?<n>\d+)\.[ \t\u00a0]+/u,
  paren: /^(?<n>\d+)\)[ \t\u00a0]+/u,
} as const;

const opensCourtMarker = (
  style: keyof typeof STYLE_MARKER,
  text: string,
): RegExpExecArray | null => {
  const match = STYLE_MARKER[style].exec(text);
  if (match === null) {
    return null;
  }
  return /^[\d\p{Ll}]/u.test(text.slice(match[0].length)) ? null : match;
};

test("court paragraph numbers are faithful, structure-preserving and idempotent", () => {
  assertProperty(
    "court paragraph numbers are faithful, structure-preserving and idempotent",
    fc.property(decision, (blocks) => {
      const numbering = extractCourtParagraphNumbers(blocks);

      expect(
        numbering.blocks.map(({ id, anchorId, type }) => [id, anchorId, type]),
      ).toEqual(blocks.map(({ id, anchorId, type }) => [id, anchorId, type]));
      if (numbering.type !== "numbered") {
        expect(numbering.blocks).toEqual(blocks);
      }
      for (const [index, after] of numbering.blocks.entries()) {
        const before = blocks[index];
        if (after.type !== "paragraph" || before?.type !== "paragraph") {
          continue;
        }
        if (after.number === undefined) {
          expect(after).toEqual(before);
          continue;
        }
        // The one number no marker states: a run printed from 2 implies the
        // 1 of the paragraph before it, which keeps its text and is reported.
        const implied =
          numbering.type === "numbered" &&
          numbering.evidence.some(
            (item) => item.type === "implied" && item.blockIndex === index,
          );
        if (implied) {
          expect(after).toEqual({ ...before, number: 1 });
          expect(MARKER_PREFIX.test(before.plainText)).toBe(false);
          continue;
        }
        const marker = MARKER_PREFIX.exec(before.plainText);
        expect(marker).not.toBeNull();
        const stated = Number(marker?.[1] ?? marker?.[2] ?? marker?.[3]);
        expect(after.number).toBe(stated);
        expect(after.plainText).toBe(
          before.plainText.slice(marker?.[0].length ?? 0).trim(),
        );
        expect(before.role === "holding" || before.role === "closing").toBe(
          false,
        );
        expect(
          (["bracket", "dot", "paren"] as const).some(
            (style) => opensCourtMarker(style, before.plainText) !== null,
          ),
        ).toBe(true);
      }

      expect(extractCourtParagraphNumbers(numbering.blocks).blocks).toEqual(
        numbering.blocks,
      );
    }),
  );
});

/**
 * A court's numbered run with lists in the same marker style after some of
 * its paragraphs. Every list is followed by the court's next paragraph, so
 * the court's numbering is what a reader reads off: 1..n, lists aside.
 */
const numberedWithLists = fc
  .record({
    style: fc.constantFrom("bracket", "dot", "paren"),
    lists: fc.array(fc.integer({ min: 0, max: 6 }), {
      minLength: 2,
      maxLength: 15,
    }),
  })
  .map(({ style, lists }) => {
    const layout: { court: number | null; text: string }[] = [];
    for (const [index, listLength] of lists.entries()) {
      const court = index + 1;
      layout.push({
        court,
        text: `${MARKERS[style](court)}Soud uvážil bod ${String(court)}.`,
      });
      if (court < lists.length) {
        for (let item = 1; item <= listLength; item += 1) {
          layout.push({
            court: null,
            text: `${MARKERS[style](item)}Položka ${String(item)}.`,
          });
        }
      }
    }
    const blocks: Block[] = layout.map(({ text }, index) => ({
      id: `b${String(index)}`,
      anchorId: `p-${String(index)}`,
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    }));
    // A list after paragraph i that counts exactly to i reads two ways: the
    // court's i+1, i+2, … carry on, or they are the list's. Nothing after it
    // tells them apart (a later list only restarts at 1), so the ambiguous
    // markers remain text.
    const ambiguous = lists.some(
      (length, index) => index + 1 < lists.length && length === index + 1,
    );
    return { blocks, courts: layout.map(({ court }) => court), ambiguous };
  });

test("lists in the court's own marker style never take the court's numbers", () => {
  assertProperty(
    "lists in the court's own marker style never take the court's numbers",
    fc.property(numberedWithLists, ({ blocks, courts, ambiguous }) => {
      const numbering = extractCourtParagraphNumbers(blocks);
      const stored = numbering.blocks.map((block) =>
        block.type === "paragraph" ? (block.number ?? null) : null,
      );
      if (!ambiguous) {
        expect(stored).toEqual(courts);
      }
      for (const [index, number] of stored.entries()) {
        if (number !== null) {
          expect(courts[index]).toBe(number);
        }
      }
    }),
  );
});

/**
 * The court's run with any number of same-style lists after each paragraph,
 * back to back. Some layouts are genuinely ambiguous; none may be read
 * wrongly.
 */
const numberedWithConsecutiveLists = fc
  .record({
    style: fc.constantFrom("bracket", "dot", "paren"),
    lists: fc.array(
      fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 3 }),
      { minLength: 2, maxLength: 12 },
    ),
  })
  .map(({ style, lists }) => {
    const layout: { court: number | null; text: string }[] = [];
    for (const [index, after] of lists.entries()) {
      const court = index + 1;
      layout.push({
        court,
        text: `${MARKERS[style](court)}Soud uvážil bod ${String(court)}.`,
      });
      if (court === lists.length) {
        continue;
      }
      for (const length of after) {
        for (let item = 1; item <= length; item += 1) {
          layout.push({
            court: null,
            text: `${MARKERS[style](item)}Položka ${String(item)}.`,
          });
        }
      }
    }
    const blocks: Block[] = layout.map(({ text }, index) => ({
      id: `b${String(index)}`,
      anchorId: `p-${String(index)}`,
      type: "paragraph",
      inlines: [{ type: "text", text }],
      plainText: text,
    }));
    return { blocks, courts: layout.map(({ court }) => court) };
  });

test("no layout of same-style lists is read into a wrong court number", () => {
  assertProperty(
    "no layout of same-style lists is read into a wrong court number",
    fc.property(numberedWithConsecutiveLists, ({ blocks, courts }) => {
      const numbering = extractCourtParagraphNumbers(blocks);
      const stored = numbering.blocks.map((block) =>
        block.type === "paragraph" ? (block.number ?? null) : null,
      );
      // Uncertain markers stay text; every stored label must still belong
      // to the court, whatever other local irregularities are present.
      for (const [index, number] of stored.entries()) {
        if (number !== null) {
          expect(courts[index]).toBe(number);
        }
      }
    }),
  );
});

const printedParagraph = (index: number, marker: string): ParagraphBlock => {
  const text = `${marker}Soud uvážil věc.`;
  return {
    id: `b${String(index)}`,
    anchorId: `p-${String(index)}`,
    type: "paragraph",
    inlines: [{ type: "text", text }],
    plainText: text,
  };
};

const labelsOf = (blocks: readonly Block[]) =>
  blocks.map((block) =>
    block.type === "paragraph" ? block.number : undefined,
  );

const localDefect = fc.record({
  length: fc.integer({ min: 3, max: 100 }),
  position: fc.nat(),
  confusable: fc.constantFrom("l", "I"),
  gap,
});

test("one OCR-confusable marker changes at most its own paragraph label", () => {
  assertProperty(
    "one OCR-confusable marker changes at most its own paragraph label",
    fc.property(localDefect, ({ length, position, confusable, gap: space }) => {
      const blocks = Array.from({ length }, (_, index) =>
        printedParagraph(index, `${String(index + 1)}.${space}`),
      );
      const eligible = blocks.flatMap((_, index) =>
        String(index + 1).includes("1") ? [index] : [],
      );
      const changed = eligible[position % eligible.length];
      if (changed === undefined) {
        throw new Error("every generated sequence includes paragraph 1");
      }
      const marker = `${String(changed + 1).replace("1", () => confusable)}.${space}`;
      const mutated = blocks.map((block, index) =>
        index === changed ? printedParagraph(index, marker) : block,
      );
      expect(mutated[changed]?.plainText).not.toBe(blocks[changed]?.plainText);
      const before = labelsOf(extractCourtParagraphNumbers(blocks).blocks);
      const result = extractCourtParagraphNumbers(mutated);
      const after = labelsOf(result.blocks);
      expect(before).toEqual(Array.from({ length }, (_, index) => index + 1));
      expect(
        after.filter((number, index) => number !== before[index]).length,
      ).toBeLessThanOrEqual(1);
      expect(after[changed]).toBe(
        changed + 1 < length ? changed + 1 : undefined,
      );
      expect(extractCourtParagraphNumbers(result.blocks).blocks).toEqual(
        result.blocks,
      );
    }),
  );
});

test("one duplicate printed marker preserves every other paragraph label", () => {
  assertProperty(
    "one duplicate printed marker preserves every other paragraph label",
    fc.property(localDefect, ({ length, position, gap: space }) => {
      // A repeated 1 could instead start a nested list. Values above 1 have
      // no such competing interpretation in this otherwise consecutive run.
      const repeated = 2 + (position % (length - 1));
      const blocks = Array.from({ length }, (_, index) =>
        printedParagraph(index, `${String(index + 1)}.${space}`),
      );
      const inserted = printedParagraph(length, `${String(repeated)}.${space}`);
      const mutated = blocks.toSpliced(repeated, 0, inserted);
      const result = extractCourtParagraphNumbers(mutated);
      expect(labelsOf(result.blocks)).toEqual(
        Array.from({ length }, (_, index) => index + 1).toSpliced(
          repeated,
          0,
          repeated,
        ),
      );
      expect(result).toMatchObject({
        type: "numbered",
        evidence: [
          {
            type: "duplicate",
            blockIndex: repeated,
            number: repeated,
            previousBlockIndex: repeated - 1,
          },
        ],
      });
    }),
  );
});

test("a gap in printed numbering preserves labels on both sides", () => {
  assertProperty(
    "a gap in printed numbering preserves labels on both sides",
    fc.property(
      fc.record({
        length: fc.integer({ min: 4, max: 100 }),
        position: fc.nat(),
        skipped: fc.integer({ min: 1, max: 100 }),
      }),
      ({ length, position, skipped }) => {
        // Two consecutive markers following a large gap prove the resumed
        // run. One isolated outlier has no such proof and remains text.
        const changed = 1 + (position % (length - 2));
        const numbers = Array.from(
          { length },
          (_, index) => index + 1 + (index >= changed ? skipped : 0),
        );
        const blocks = numbers.map((number, index) =>
          printedParagraph(index, `${String(number)}. `),
        );
        expect(labelsOf(extractCourtParagraphNumbers(blocks).blocks)).toEqual(
          numbers,
        );
      },
    ),
  );
});

test("separate opinions choose their own marker style and keep continuation numbering", () => {
  const majority = Array.from({ length: 10 }, (_, index) =>
    printedParagraph(index, `[${String(index + 1)}] `),
  );
  const heading: Block = {
    type: "heading",
    id: "opinion",
    anchorId: "opinion",
    level: 2,
    plainText: "Odlišné stanovisko soudce",
    inlines: [{ type: "text", text: "Odlišné stanovisko soudce" }],
  };
  const dissent = [11, 12].map((number) => ({
    ...printedParagraph(number, `${String(number)}. `),
    role: "dissent" as const,
  }));
  const blocks = [...majority, heading, ...dissent];
  const result = extractCourtParagraphNumbers(blocks);
  expect(result).toMatchObject({
    type: "numbered",
    scopes: [
      { type: "fresh-start", blockIndex: 0 },
      { type: "continuation", blockIndex: 11 },
    ],
  });
  expect(labelsOf(result.blocks)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => index + 1),
    undefined,
    11,
    12,
  ]);
  const numberedMajority = extractCourtParagraphNumbers(majority).blocks;
  expect(
    labelsOf(
      extractCourtParagraphNumbers([...numberedMajority, heading, ...dissent])
        .blocks,
    ),
  ).toEqual([
    ...Array.from({ length: 10 }, (_, index) => index + 1),
    undefined,
    11,
    12,
  ]);
});

test("internal headings do not restart a dissent's numbering scope", () => {
  const heading: Block = {
    type: "heading",
    id: "internal",
    anchorId: "internal",
    level: 3,
    plainText: "II. Posouzení",
    inlines: [{ type: "text", text: "II. Posouzení" }],
  };
  const dissent = [1, 2, 3, 4].map((number) => ({
    ...printedParagraph(number, `${String(number)}. `),
    role: "dissent" as const,
  }));
  const blocks = [...dissent.slice(0, 2), heading, ...dissent.slice(2)];
  expect(labelsOf(extractCourtParagraphNumbers(blocks).blocks)).toEqual([
    1,
    2,
    undefined,
    3,
    4,
  ]);
});

test("partly numbered paragraphs recover labels between numbered neighbours", () => {
  const blocks = [1, 2, 3].map((number, index) =>
    printedParagraph(index, `${String(number)}. `),
  );
  const anchors = blocks.map((block, index) =>
    index === 1
      ? block
      : {
          ...block,
          number: index + 1,
          plainText: "Soud uvážil věc.",
          inlines: [{ type: "text" as const, text: "Soud uvážil věc." }],
        },
  );
  const result = extractCourtParagraphNumbers(anchors);
  expect(labelsOf(result.blocks)).toEqual([1, 2, 3]);
  expect(extractCourtParagraphNumbers(result.blocks).blocks).toEqual(
    result.blocks,
  );
});

test("a different-style list continuation is not promoted across a court numbering gap", () => {
  const first = {
    ...printedParagraph(0, "1. "),
    number: 1,
  };
  const second = printedParagraph(1, "2. ");
  const third = {
    ...printedParagraph(2, ""),
    number: 3,
  };

  const result = extractCourtParagraphNumbers([first, second, third]);

  expect(labelsOf(result.blocks)).toEqual([1, undefined, 3]);
  expect(result.blocks[0]?.plainText).toBe("1. Soud uvážil věc.");
  expect(result.blocks[1]?.plainText).toBe("2. Soud uvážil věc.");
});

test("a lone different-style marker is recovered across a court numbering gap", () => {
  const first = {
    ...printedParagraph(0, ""),
    number: 1,
  };
  const second = printedParagraph(1, "2. ");
  const third = {
    ...printedParagraph(2, ""),
    number: 3,
  };

  const result = extractCourtParagraphNumbers([first, second, third]);

  expect(labelsOf(result.blocks)).toEqual([1, 2, 3]);
  expect(result.blocks[1]?.plainText).toBe("Soud uvážil věc.");
});

test("a dissent beginning at 2 does not continue the majority's paragraph 10", () => {
  const majority = Array.from({ length: 10 }, (_, index) =>
    printedParagraph(index, `${String(index + 1)}. `),
  );
  const heading: Block = {
    type: "heading",
    id: "opinion",
    anchorId: "opinion",
    level: 2,
    plainText: "Odlišné stanovisko soudce",
    inlines: [{ type: "text", text: "Odlišné stanovisko soudce" }],
  };
  const dissent = [2, 3, 4].map((number, index) => ({
    ...printedParagraph(11 + index, `${String(number)}. `),
    role: "dissent" as const,
  }));
  const result = extractCourtParagraphNumbers([
    ...majority,
    heading,
    ...dissent,
  ]);
  expect(labelsOf(result.blocks)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => index + 1),
    undefined,
    2,
    3,
    4,
  ]);
  expect(result).toMatchObject({
    type: "numbered",
    scopes: [
      { type: "fresh-start", blockIndex: 0 },
      { type: "fresh-start", blockIndex: 11 },
    ],
  });
});

test("each separate opinion may start a fresh numbering after a longer majority", () => {
  assertProperty(
    "each separate opinion may start a fresh numbering after a longer majority",
    fc.property(
      fc.record({
        majorityLength: fc.integer({ min: 10, max: 40 }),
        first: fc.integer({ min: 2, max: 4 }),
        opinionLength: fc.integer({ min: 3, max: 10 }),
        majorityStyle: fc.constantFrom("bracket", "dot", "paren"),
        opinionStyle: fc.constantFrom("bracket", "dot", "paren"),
        preamble: fc.boolean(),
      }),
      ({
        majorityLength,
        first,
        opinionLength,
        majorityStyle,
        opinionStyle,
        preamble,
      }) => {
        const majority = Array.from({ length: majorityLength }, (_, index) =>
          printedParagraph(index, MARKERS[majorityStyle](index + 1)),
        );
        const heading: Block = {
          type: "heading",
          id: "opinion",
          anchorId: "opinion",
          level: 2,
          plainText: "Odlišné stanovisko soudce",
          inlines: [{ type: "text", text: "Odlišné stanovisko soudce" }],
        };
        const opinionStart = majorityLength + 1 + (preamble ? 1 : 0);
        const introduction = preamble
          ? [
              {
                ...printedParagraph(majorityLength + 1, ""),
                role: "dissent" as const,
              },
            ]
          : [];
        const dissent = Array.from({ length: opinionLength }, (_, index) => ({
          ...printedParagraph(
            opinionStart + index,
            MARKERS[opinionStyle](first + index),
          ),
          role: "dissent" as const,
        }));
        const blocks = [...majority, heading, ...introduction, ...dissent];
        const result = extractCourtParagraphNumbers(blocks);
        expect(labelsOf(result.blocks)).toEqual([
          ...Array.from({ length: majorityLength }, (_, index) => index + 1),
          undefined,
          ...(preamble ? [undefined] : []),
          ...Array.from({ length: opinionLength }, (_, index) => first + index),
        ]);
        expect(result).toMatchObject({
          type: "numbered",
          scopes: [
            { type: "fresh-start", blockIndex: 0 },
            { type: "fresh-start", blockIndex: opinionStart },
          ],
        });
        expect(extractCourtParagraphNumbers(result.blocks).blocks).toEqual(
          result.blocks,
        );
      },
    ),
  );
});

test("short separate opinions share evidence only when their printed run continues", () => {
  assertProperty(
    "short separate opinions share evidence only when their printed run continues",
    fc.property(
      fc.record({
        majorityLength: fc.constantFrom(1, 10),
        majorityStyle: fc.constantFrom("dot", "paren"),
        opinionStyle: fc.constantFrom("dot", "paren"),
        continuation: fc.boolean(),
        preamble: fc.boolean(),
      }),
      ({
        majorityLength,
        majorityStyle,
        opinionStyle,
        continuation,
        preamble,
      }) => {
        const majority = Array.from({ length: majorityLength }, (_, index) =>
          printedParagraph(index, MARKERS[majorityStyle](index + 1)),
        );
        const heading: Block = {
          type: "heading",
          id: "opinion",
          anchorId: "opinion",
          level: 2,
          plainText: "Odlišné stanovisko soudce",
          inlines: [{ type: "text", text: "Odlišné stanovisko soudce" }],
        };
        const introduction = preamble
          ? [
              {
                ...printedParagraph(majorityLength + 1, ""),
                role: "dissent" as const,
              },
            ]
          : [];
        const opinionStart = majorityLength + 1 + (preamble ? 1 : 0);
        const printedNumber = continuation ? majorityLength + 1 : 1;
        const opinion = {
          ...printedParagraph(
            opinionStart,
            MARKERS[opinionStyle](printedNumber),
          ),
          role: "dissent" as const,
        };
        const result = extractCourtParagraphNumbers([
          ...majority,
          heading,
          ...introduction,
          opinion,
        ]);
        expect(labelsOf(result.blocks)).toEqual([
          ...Array.from({ length: majorityLength }, (_, index) =>
            continuation || majorityLength > 1 ? index + 1 : undefined,
          ),
          undefined,
          ...(preamble ? [undefined] : []),
          continuation ? printedNumber : undefined,
        ]);
        if (continuation) {
          expect(result).toMatchObject({
            type: "numbered",
            scopes: [
              { type: "fresh-start", blockIndex: 0 },
              { type: "continuation", blockIndex: opinionStart },
            ],
          });
        }
        expect(extractCourtParagraphNumbers(result.blocks).blocks).toEqual(
          result.blocks,
        );
      },
    ),
  );
});

test("a lone dot marker without corroboration stays text", () => {
  const blocks = [printedParagraph(0, "1. ")];
  expect(extractCourtParagraphNumbers(blocks)).toEqual({
    type: "unnumbered",
    blocks,
  });
});

test("a sparse short scope cannot corroborate a later opinion's marker", () => {
  const majority = [
    printedParagraph(0, "1. "),
    ...Array.from({ length: 4 }, (_, index) => printedParagraph(index + 1, "")),
  ];
  const heading: Block = {
    type: "heading",
    id: "opinion",
    anchorId: "opinion",
    level: 2,
    plainText: "Odlišné stanovisko soudce",
    inlines: [{ type: "text", text: "Odlišné stanovisko soudce" }],
  };
  const dissent = { ...printedParagraph(6, "2. "), role: "dissent" as const };
  const blocks = [...majority, heading, dissent];
  expect(extractCourtParagraphNumbers(blocks)).toEqual({
    type: "unnumbered",
    blocks,
  });
});

test.each([
  [
    "Odlišné stanovisko sudcu Jána Nováka",
    "Odlišné stanovisko sudcu Petra Nováka",
  ],
  [
    "Odlišné stanovisko sudcu Jána Nováka",
    "Paralelné stanovisko sudkyne Evy Novákovej",
  ],
  [
    "Odlišné stanovisko soudce Jana Nováka",
    "Konkurujúce stanovisko sudkyne Evy Novákovej",
  ],
])(
  "separate opinion headings retain two printed 1..3 scopes: %s / %s",
  (firstTitle, secondTitle) => {
    const majority = [1, 2, 3, 4].map((number, index) =>
      printedParagraph(index, `${String(number)}. `),
    );
    const firstHeading: Block = {
      type: "heading",
      id: "first-opinion",
      anchorId: "first-opinion",
      level: 2,
      plainText: firstTitle,
      inlines: [{ type: "text", text: firstTitle }],
    };
    const secondHeading: Block = {
      type: "heading",
      id: "second-opinion",
      anchorId: "second-opinion",
      level: 2,
      plainText: secondTitle,
      inlines: [{ type: "text", text: secondTitle }],
    };
    const first = [1, 2, 3].map((number, index) => ({
      ...printedParagraph(index + 5, `${String(number)}. `),
      role: "dissent" as const,
    }));
    const second = [1, 2, 3].map((number, index) => ({
      ...printedParagraph(index + 9, `${String(number)}. `),
      role: "dissent" as const,
    }));
    const result = extractCourtParagraphNumbers([
      ...majority,
      firstHeading,
      ...first,
      secondHeading,
      ...second,
    ]);
    expect(labelsOf(result.blocks)).toEqual([
      1,
      2,
      3,
      4,
      undefined,
      1,
      2,
      3,
      undefined,
      1,
      2,
      3,
    ]);
    expect(result).toMatchObject({
      type: "numbered",
      scopes: [
        { type: "fresh-start", blockIndex: 0 },
        { type: "fresh-start", blockIndex: 5 },
        { type: "fresh-start", blockIndex: 9 },
      ],
    });
  },
);

test("recognized CS/SK opinion headings start independent numbering regardless of paragraph roles", () => {
  assertProperty(
    "recognized CS/SK opinion headings start independent numbering regardless of paragraph roles",
    fc.property(
      fc.record({
        majorityLength: fc.integer({ min: 3, max: 10 }),
        firstRoles: fc.array(
          fc.constantFrom(undefined, "argumentation", "dissent"),
          { minLength: 2, maxLength: 8 },
        ),
        secondRoles: fc.array(
          fc.constantFrom(undefined, "argumentation", "dissent"),
          { minLength: 2, maxLength: 8 },
        ),
        firstTitle: fc.constantFrom(
          "Odlišné stanovisko sudcu",
          "Odlišné stanovisko soudce",
          "Odlišná stanoviska soudců",
          "Odlišné stanoviská sudkýň",
        ),
        secondTitle: fc.constantFrom(
          "Odlišné stanovisko sudcu",
          "Paralelné stanovisko sudkyne",
          "Konkurujúce stanoviská sudcov",
          "Souhlasné stanovisko soudkyně",
        ),
      }),
      ({
        majorityLength,
        firstRoles,
        secondRoles,
        firstTitle,
        secondTitle,
      }) => {
        const firstLength = firstRoles.length;
        const secondLength = secondRoles.length;
        const majority = Array.from({ length: majorityLength }, (_, index) =>
          printedParagraph(index, `${String(index + 1)}. `),
        );
        const firstHeading: Block = {
          type: "heading",
          id: "first-opinion",
          anchorId: "first-opinion",
          level: 2,
          plainText: firstTitle,
          inlines: [{ type: "text", text: firstTitle }],
        };
        const secondHeading: Block = {
          type: "heading",
          id: "second-opinion",
          anchorId: "second-opinion",
          level: 2,
          plainText: secondTitle,
          inlines: [{ type: "text", text: secondTitle }],
        };
        const firstStart = majorityLength + 1;
        const secondStart = firstStart + firstLength + 1;
        const first = Array.from({ length: firstLength }, (_, index) => ({
          ...printedParagraph(firstStart + index, `${String(index + 1)}. `),
          role: firstRoles[index],
        }));
        const second = Array.from({ length: secondLength }, (_, index) => ({
          ...printedParagraph(secondStart + index, `${String(index + 1)}. `),
          role: secondRoles[index],
        }));
        const result = extractCourtParagraphNumbers([
          ...majority,
          firstHeading,
          ...first,
          secondHeading,
          ...second,
        ]);
        expect(labelsOf(result.blocks)).toEqual([
          ...Array.from({ length: majorityLength }, (_, index) => index + 1),
          undefined,
          ...Array.from({ length: firstLength }, (_, index) => index + 1),
          undefined,
          ...Array.from({ length: secondLength }, (_, index) => index + 1),
        ]);
        expect(result).toMatchObject({
          type: "numbered",
          scopes: [
            { type: "fresh-start", blockIndex: 0 },
            { type: "fresh-start", blockIndex: firstStart },
            { type: "fresh-start", blockIndex: secondStart },
          ],
        });
        expect(extractCourtParagraphNumbers(result.blocks).blocks).toEqual(
          result.blocks,
        );
      },
    ),
  );
});

test.each([
  "Souhlasné stanovisko podle § 149 odst. 1 správního řádu",
  "Súhlasné stanovisko podľa § 149 ods. 1 správneho poriadku",
])(
  "administrative consent heading keeps the court's numbering scope: %s",
  (title) => {
    const before = [1, 2, 3, 4].map((number, index) =>
      printedParagraph(index, `${String(number)}. `),
    );
    const heading: Block = {
      type: "heading",
      id: "administrative-consent",
      anchorId: "administrative-consent",
      level: 2,
      plainText: title,
      inlines: [{ type: "text", text: title }],
    };
    const after = [5, 6, 7].map((number, index) =>
      printedParagraph(index + 5, `${String(number)}. `),
    );
    const result = extractCourtParagraphNumbers([...before, heading, ...after]);
    expect(labelsOf(result.blocks)).toEqual([1, 2, 3, 4, undefined, 5, 6, 7]);
    expect(result).toMatchObject({
      type: "numbered",
      scopes: [{ type: "fresh-start", blockIndex: 0 }],
    });
  },
);

const paragraphOf = (index: number, text: string): ParagraphBlock => ({
  id: `b${String(index)}`,
  anchorId: `p-${String(index)}`,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

test("a nested list starting at the last court number stays a list", () => {
  const texts = [
    "1. Soud uvážil věc.",
    "2. Soud uvážil věc.",
    "3. Soud uvážil tyto body:",
    "3. První bod seznamu;",
    "4. Druhý bod seznamu.",
    "4. Soud uvážil věc.",
    "5. Soud uvážil věc.",
  ];
  const result = extractCourtParagraphNumbers(
    texts.map((text, index) => paragraphOf(index, text)),
  );
  expect(labelsOf(result.blocks)).toEqual([
    1,
    2,
    3,
    undefined,
    undefined,
    4,
    5,
  ]);
});

test("a Roman section title is not an OCR-damaged paragraph 1", () => {
  const texts = [
    "I. Skutkový stav",
    "2. Soud uvážil věc.",
    "3. Soud uvážil věc.",
  ];
  const result = extractCourtParagraphNumbers(
    texts.map((text, index) => paragraphOf(index, text)),
  );
  expect(
    result.blocks.at(0)?.type === "paragraph" ? result.blocks.at(0) : undefined,
  ).toMatchObject({
    plainText: "I. Skutkový stav",
  });
  expect(labelsOf(result.blocks).at(0)).toBeUndefined();
});

/** A decision's head matter, its ruling, and the reasoning that follows. */
type Layout = { readonly text: string; readonly role?: "holding" }[];

const blocksOf = (layout: Layout): Block[] =>
  layout.map(({ text, role }, index) => ({
    ...paragraphOf(index, text),
    ...(role === undefined ? {} : { role }),
  }));

const UNNUMBERED = [
  "Ze spisu soud zjistil a vzal za prokázáno, že žalovaný účet nezřídil.",
  "v exekučním řízení byla vymožena částka, která nebyla vyplacena;",
  "Soud provedl důkaz listinami, které účastníci předložili.",
  "žalovaný nehradil své závazky;",
] as const;

const unnumbered = (count: number, seed: number): Layout =>
  Array.from({ length: count }, (_, index) => ({
    text: UNNUMBERED[(seed + index) % UNNUMBERED.length] ?? "Text.",
  }));

/** Head matter a parser left without a role, then the ruling. */
const headAndRuling = (headLines: number): Layout =>
  headLines === 0
    ? []
    : [
        ...Array.from({ length: headLines }, (_, index) => ({
          text: `Hlavička ${String(index + 1)}`,
        })),
        { text: "I. Žalovaný je povinen zaplatit částku.", role: "holding" },
      ];

test("a run counting up from 1 is numbered however much unnumbered text it carries", () => {
  assertProperty(
    "a run counting up from 1 is numbered however much unnumbered text it carries",
    fc.property(
      fc.record({
        headLines: fc.integer({ min: 0, max: 8 }),
        leadIn: fc.integer({ min: 0, max: 4 }),
        between: fc.array(fc.integer({ min: 0, max: 20 }), {
          minLength: 2,
          maxLength: 24,
        }),
        tail: fc.integer({ min: 0, max: 4 }),
        seed: fc.nat({ max: 3 }),
        space: gap,
      }),
      ({ headLines, leadIn, between, tail: closing, seed, space }) => {
        // A closing line or two, never more than the run spreads over.
        const tail = Math.min(closing, Math.max(0, ...between));
        const layout: Layout[number][] = [
          ...headAndRuling(headLines),
          ...unnumbered(leadIn, seed),
        ];
        const expected: (number | undefined)[] = layout.map(() => undefined);
        const count = between.length + 1;
        for (let number = 1; number <= count; number += 1) {
          layout.push({
            text: `${MARKERS.dot(number, space)}Soud uvážil bod ${String(number)}.`,
          });
          expected.push(number);
          const filler = number === count ? tail : (between[number - 1] ?? 0);
          for (const item of unnumbered(filler, seed + number)) {
            layout.push(item);
            expected.push(undefined);
          }
        }
        const result = extractCourtParagraphNumbers(blocksOf(layout));
        expect(labelsOf(result.blocks)).toEqual(expected);
      },
    ),
  );
});

test("a short list that the reasoning runs on after is not numbering", () => {
  // The items of a list, or a quoted statute's "1." and "2.", in an
  // unnumbered reasoning: the text that follows them is not theirs.
  assertProperty(
    "a short list that the reasoning runs on after is not numbering",
    fc.property(
      fc
        .record({
          leadIn: fc.integer({ min: 0, max: 12 }),
          items: fc.integer({ min: 2, max: 5 }),
          seed: fc.nat({ max: 3 }),
        })
        .chain((shape) =>
          fc.record({
            shape: fc.constant(shape),
            // More than a closing after the list, and more text than list.
            tail: fc.integer({
              min: Math.max(5, Math.ceil(shape.items * 1.5) + 1),
              max: 40,
            }),
          }),
        ),
      ({ shape: { leadIn, items, seed }, tail }) => {
        const layout: Layout = [
          ...unnumbered(leadIn, seed),
          ...Array.from({ length: items }, (_, index) => ({
            text: `${MARKERS.dot(index + 1, " ")}Položka zákona ${String(index + 1)}.`,
          })),
          ...unnumbered(tail, seed + 1),
        ];
        const blocks = blocksOf(layout);
        expect(extractCourtParagraphNumbers(blocks).blocks).toEqual(blocks);
      },
    ),
  );
});

test("a statute quoted inside a numbered run keeps its items as text", () => {
  assertProperty(
    "a statute quoted inside a numbered run keeps its items as text",
    fc.property(
      fc.record({
        count: fc.integer({ min: 5, max: 20 }),
        quotedAfter: fc.integer({ min: 4, max: 19 }),
        quoted: fc.integer({ min: 2, max: 3 }),
        filler: fc.integer({ min: 0, max: 12 }),
      }),
      ({ count, quotedAfter, quoted, filler }) => {
        const after = Math.min(quotedAfter, count - 1);
        const layout: Layout[number][] = [];
        const expected: (number | undefined)[] = [];
        for (let number = 1; number <= count; number += 1) {
          layout.push({
            text: `${MARKERS.dot(number, " ")}Soud uvážil bod ${String(number)}.`,
          });
          expected.push(number);
          const extra: Layout = [
            ...(number === after
              ? Array.from({ length: quoted }, (_, index) => ({
                  text: `${MARKERS.dot(index + 1, " ")}Ustanovení odstavce ${String(index + 1)}.`,
                }))
              : []),
            ...unnumbered(number === 1 ? filler : 0, number),
          ];
          for (const item of extra) {
            layout.push(item);
            expected.push(undefined);
          }
        }
        const result = extractCourtParagraphNumbers(blocksOf(layout));
        expect(labelsOf(result.blocks)).toEqual(expected);
      },
    ),
  );
});

test("the one paragraph opening the reasoning before a printed 2 is paragraph 1", () => {
  const ruling: Layout = [
    { text: "Ústavný súd Slovenskej republiky" },
    { text: "III. ÚS 298/2018-33" },
    { text: "Ústavný súd na neverejnom zasadnutí rozhodol:" },
    { text: "Základné právo porušené bolo.", role: "holding" },
  ];
  const run: Layout = [2, 3, 4, 5].map((number) => ({
    text: `${String(number)}. Ústavný súd uvážil bod ${String(number)}.`,
  }));
  const opening = { text: "Ústavný súd predbežne prerokoval sťažnosť." };
  const one = extractCourtParagraphNumbers(
    blocksOf([...ruling, opening, ...run]),
  );
  expect(labelsOf(one.blocks)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    1,
    2,
    3,
    4,
    5,
  ]);
  expect(one.blocks.at(4)?.plainText).toBe(opening.text);
  expect(one.type === "numbered" ? one.evidence : []).toContainEqual({
    type: "implied",
    blockIndex: 4,
    number: 1,
  });

  // Two paragraphs before the 2: which of them is the court's 1 is not
  // fixed, so neither is given it, and the printed run is still read.
  const two = extractCourtParagraphNumbers(
    blocksOf([
      ...ruling,
      opening,
      { text: "Sťažovateľka namieta porušenie práva." },
      ...run,
    ]),
  );
  expect(labelsOf(two.blocks)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    2,
    3,
    4,
    5,
  ]);

  // With no ruling before it, the paragraph does not provably open the
  // reasoning, so it stays unnumbered.
  const headless = extractCourtParagraphNumbers(blocksOf([opening, ...run]));
  expect(labelsOf(headless.blocks)).toEqual([undefined, 2, 3, 4, 5]);
});

test("two titled halves of a part are not a count of its paragraphs", () => {
  const layout: Layout = [
    { text: "1. K výroku, kterým byl zamítnut návrh." },
    ...unnumbered(3, 0),
    { text: "2. K výroku, kterým bylo zrušeno ustanovení." },
    ...unnumbered(2, 1),
  ];
  const blocks = blocksOf(layout);
  expect(extractCourtParagraphNumbers(blocks).blocks).toEqual(blocks);
});
