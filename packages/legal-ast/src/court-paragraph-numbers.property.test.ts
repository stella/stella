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
  expect(labelsOf(extractCourtParagraphNumbers(blocks).blocks)).toEqual([
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
