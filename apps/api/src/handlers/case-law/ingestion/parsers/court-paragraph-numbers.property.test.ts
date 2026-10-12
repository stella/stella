/**
 * What must hold for any decision, numbered or not.
 *
 * - Faithful: a numbered paragraph's text is the printed text with only the
 *   marker removed, and the marker states exactly the stored number.
 * - Structure-preserving: the same blocks, ids and anchors, in order.
 * - Idempotent: a second pass changes nothing — a re-parse or a replay of a
 *   numbered decision cannot number its nested lists.
 * - Sound: stored numbers come from markers alone, and a rejected or
 *   unnumbered outcome leaves the blocks exactly as they were.
 */

import { expect, test } from "bun:test";
import fc from "fast-check";

import type { Block, ParagraphBlock } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { extractCourtParagraphNumbers } from "@/api/handlers/case-law/ingestion/parsers/court-paragraph-numbers";

const MARKERS = {
  bracket: (number: number) => `[${String(number)}] `,
  dot: (number: number) => `${String(number)}.\t`,
  paren: (number: number) => `${String(number)}) `,
} as const;

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
  readonly text: string;
};

const draft: fc.Arbitrary<Draft> = fc.record({
  role: fc.constantFrom(undefined, undefined, "holding", "dissent", "closing"),
  marker: fc.constantFrom(null, "bracket", "dot", "dot", "paren"),
  number: fc.integer({ min: 1, max: 40 }),
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
          : `${MARKERS[item.marker](number)}${item.text}`;
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

const MARKER_PREFIX = /^(?:\[(\d+)\][ \t]*|(\d+)\.[ \t]+|(\d+)\)[ \t]+)/u;

const STYLE_MARKER = {
  bracket: /^\[(?<n>\d+)\][ \t]*(?![\d\p{Ll}])/u,
  dot: /^(?<n>\d+)\.[ \t]+(?![\d\p{Ll}])/u,
  paren: /^(?<n>\d+)\)[ \t]+(?![\d\p{Ll}])/u,
} as const;

const isBody = (block: Block): block is ParagraphBlock =>
  block.type === "paragraph" &&
  (block.role === undefined || block.role === "dissent");

/**
 * The two hard invariants of a stored numbering, checked from the outside:
 * the numbers strictly rise (starting again only at 1), and every marker of
 * the numbering's style left in the text is an item of a list that started
 * at 1 after a numbered paragraph and counts up without a gap.
 */
const invariantViolations = (
  before: readonly Block[],
  after: readonly Block[],
): string[] => {
  const numbered = after.flatMap((block, index) =>
    block.type === "paragraph" && block.number !== undefined
      ? [{ index, number: block.number }]
      : [],
  );
  const first = numbered.at(0);
  if (first === undefined) {
    return [];
  }
  const source = before[first.index];
  const style = (
    Object.keys(STYLE_MARKER) as (keyof typeof STYLE_MARKER)[]
  ).find(
    (candidate) =>
      source?.type === "paragraph" &&
      STYLE_MARKER[candidate].test(source.plainText),
  );
  if (style === undefined) {
    return ["a numbered paragraph had no marker"];
  }
  const problems: string[] = [];
  for (const [position, { number }] of numbered.entries()) {
    const previous = numbered[position - 1]?.number ?? 0;
    if (number <= previous && number !== 1) {
      problems.push(`${String(number)} after ${String(previous)}`);
    }
  }
  let seenNumbered = false;
  let listLength = 0;
  for (const block of after) {
    if (!isBody(block)) {
      continue;
    }
    if (block.number !== undefined) {
      seenNumbered = true;
      listLength = 0;
      continue;
    }
    const raw = STYLE_MARKER[style].exec(block.plainText)?.groups?.["n"];
    if (raw === undefined || !seenNumbered) {
      continue;
    }
    const value = Number(raw);
    if (value === 1) {
      listLength = 1;
    } else if (value === listLength + 1) {
      listLength = value;
    } else {
      problems.push(`unassigned marker ${String(value)}`);
    }
  }
  return problems;
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
      }

      expect(extractCourtParagraphNumbers(numbering.blocks).blocks).toEqual(
        numbering.blocks,
      );
      expect(invariantViolations(blocks, numbering.blocks)).toEqual([]);
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
    // tells them apart (a later list only restarts at 1), so the decision
    // must be rejected.
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
      // Ambiguous: rejected, or — when what is left is too short to be a
      // numbering at all — unnumbered. Either way, nothing is stored.
      expect(numbering.type === "numbered").toBe(!ambiguous);
      expect(
        numbering.blocks.map((block) =>
          block.type === "paragraph" ? (block.number ?? null) : null,
        ),
      ).toEqual(ambiguous ? courts.map(() => null) : courts);
      expect(invariantViolations(blocks, numbering.blocks)).toEqual([]);
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
      // Either the court's own numbers exactly, or nothing at all.
      expect(stored).toEqual(
        numbering.type === "numbered" ? courts : courts.map(() => null),
      );
      expect(invariantViolations(blocks, numbering.blocks)).toEqual([]);
    }),
  );
});
