import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import type { Block } from "@stll/legal-ast/document-ast";
import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  actCompareSide,
  compareStatuteBlocks,
  groupCompareRows,
  locateCompareRows,
  pairCompareSides,
  provisionCompareSide,
  provisionWordingSide,
  resolveCompareVersions,
  splitDiffSides,
  visibleCompareGroups,
} from "@/features/statutes/statute-compare";
import type {
  CompareSideState,
  StatuteCompareRow,
} from "@/features/statutes/statute-compare";
import { STATUTE_COMPARE_SHOW } from "@/features/statutes/statute-compare-search";
import type { StatuteCompareSide } from "@/features/statutes/statute-diff-marks";

const textOf = (side: StatuteCompareSide | null): string | null =>
  side === null ? null : side.segments.map((segment) => segment.text).join("");

const segmentTypes = (
  side: StatuteCompareSide | null | undefined,
): WordDiffSegment["type"][] =>
  side?.segments.map((segment) => segment.type) ?? [];

const heading = (value: string): Block => ({
  type: "heading",
  id: `h:${value}`,
  anchorId: `h:${value}`,
  level: 4,
  inlines: [{ type: "text", text: value }],
  plainText: value,
});
const text = (value: string): Block => ({
  type: "paragraph",
  id: `p:${value}`,
  anchorId: `p:${value}`,
  inlines: [{ type: "text", text: value }],
  plainText: value,
});

const rowsOf = (
  older: readonly Block[],
  newer: readonly Block[],
): StatuteCompareRow[] => {
  const result = compareStatuteBlocks({ newer, older });

  if (result.isErr()) {
    throw result.error;
  }

  return result.value;
};

describe("compared sides", () => {
  const cases: Record<string, [string, string]> = {
    rewording: ["The seller shall deliver", "The seller must deliver"],
    insertion: ["within ten days", "within ten working days"],
    deletion: ["a written or oral contract", "a written contract"],
    replacement: ["alpha", "omega"],
    unchanged: ["same wording", "same wording"],
    fromEmpty: ["", "new wording"],
    toEmpty: ["old wording", ""],
  };

  // Each side must read back as exactly its own wording, whatever the diff
  // did in between: the columns are the texts, not a rendering of the diff.
  for (const [name, [before, after]] of Object.entries(cases)) {
    test(`reconstructs both wordings: ${name}`, () => {
      const result = compareStatuteBlocks({
        newer: [text(after)],
        older: [text(before)],
      });

      if (result.isErr()) {
        throw result.error;
      }

      const sides = result.value.map((row) => ({
        after: textOf(row.after) ?? "",
        before: textOf(row.before) ?? "",
      }));

      expect(sides.map((side) => side.before).join("")).toBe(before);
      expect(sides.map((side) => side.after).join("")).toBe(after);
    });
  }

  test("keeps deletions on the left and insertions on the right only", () => {
    const { after, before } = splitDiffSides([
      { type: "equal", text: "a " },
      { type: "del", text: "b " },
      { type: "ins", text: "c " },
      { type: "equal", text: "d" },
    ]);

    expect(before.map((segment) => segment.type)).toEqual([
      "equal",
      "del",
      "equal",
    ]);
    expect(after.map((segment) => segment.type)).toEqual([
      "equal",
      "ins",
      "equal",
    ]);
  });
});

describe("compareStatuteBlocks", () => {
  test("pairs a reworded paragraph on one row", () => {
    const rows = rowsOf(
      [heading("§ 1"), text("(1) The buyer pays the price.")],
      [heading("§ 1"), text("(1) The buyer pays the agreed price.")],
    );

    expect(rows.map((row) => row.status)).toEqual(["unchanged", "changed"]);
    expect(textOf(rows[1]?.before ?? null)).toBe(
      "(1) The buyer pays the price.",
    );
    expect(textOf(rows[1]?.after ?? null)).toBe(
      "(1) The buyer pays the agreed price.",
    );
  });

  test("carries each side's own AST blocks, for the reader to render", () => {
    const older = [heading("§ 1"), text("(1) The buyer pays the price.")];
    const newer = [
      heading("§ 1"),
      text("(1) The buyer pays the agreed price."),
    ];
    const rows = rowsOf(older, newer);

    expect(rows.flatMap((row) => row.before?.blocks ?? [])).toEqual(older);
    expect(rows.flatMap((row) => row.after?.blocks ?? [])).toEqual(newer);
    expect(rows[1]?.before?.blocks[0]).toBe(older[1]);
  });

  test("does not list a row whose versions differ only in whitespace", () => {
    const rows = rowsOf(
      [text("(1) The buyer pays the price.")],
      [text("(1) The buyer  pays the price.")],
    );

    expect(textOf(rows[0]?.before ?? null)).not.toBe(
      textOf(rows[0]?.after ?? null),
    );
    expect(rows.map((row) => row.status)).toEqual(["unchanged"]);
  });

  test("leaves the missing side empty for an added or dropped paragraph", () => {
    const added = rowsOf(
      [heading("§ 1"), text("(1) First.")],
      [
        heading("§ 1"),
        text("(1) First."),
        text("(2) An entirely different second paragraph."),
      ],
    );
    const dropped = rowsOf(
      [
        heading("§ 1"),
        text("(1) First."),
        text("(2) An entirely different second paragraph."),
      ],
      [heading("§ 1"), text("(1) First.")],
    );

    expect(added.at(-1)?.before).toBeNull();
    expect(added.at(-1)?.status).toBe("changed");
    expect(dropped.at(-1)?.after).toBeNull();
    expect(dropped.at(-1)?.status).toBe("changed");
  });
});

describe("groupCompareRows", () => {
  const rows = rowsOf(
    [
      heading("PART ONE"),
      heading("§ 1"),
      text("(1) Unchanged."),
      heading("§ 2"),
      text("(1) Old wording of the second section."),
      heading("§ 3"),
      text("(1) Also unchanged."),
    ],
    [
      heading("PART ONE"),
      heading("§ 1"),
      text("(1) Unchanged."),
      heading("§ 2"),
      text("(1) New wording of the second section."),
      heading("§ 3"),
      text("(1) Also unchanged."),
    ],
  );
  const groups = groupCompareRows(rows);

  test("opens a group per provision, with the headings stacked above it", () => {
    expect(groups.map((group) => group.rows.length)).toEqual([3, 2, 2]);
  });

  test("marks only the provision whose wording changed", () => {
    expect(groups.map((group) => group.status)).toEqual([
      "unchanged",
      "changed",
      "unchanged",
    ]);
  });

  test("lists every row exactly once", () => {
    expect(groups.flatMap((group) => group.rows)).toEqual(rows);
  });

  test("filters to changed provisions unless all are asked for", () => {
    expect(visibleCompareGroups(groups, STATUTE_COMPARE_SHOW.changed)).toEqual(
      groups.slice(1, 2),
    );
    expect(visibleCompareGroups(groups, STATUTE_COMPARE_SHOW.all)).toEqual(
      groups,
    );
  });
});

describe("moved paragraphs", () => {
  const moving =
    "(3) Whoever breaches a duty imposed by this Act compensates the damage caused in full under the provisions on damages.";
  const reworded = moving.replace("in full", "entirely");
  const rows = rowsOf(
    [
      heading("§ 1"),
      text("(1) The first paragraph stays exactly as it was in both versions."),
      text(moving),
      heading("§ 2"),
      text("(1) The second section stays unchanged in both versions."),
      heading("§ 3"),
      text("(1) The third section also stays unchanged throughout."),
    ],
    [
      heading("§ 1"),
      text("(1) The first paragraph stays exactly as it was in both versions."),
      heading("§ 2"),
      text("(1) The second section stays unchanged in both versions."),
      heading("§ 3"),
      text("(1) The third section also stays unchanged throughout."),
      text(reworded),
    ],
  );
  const source = rows.find((row) => row.move?.end === "source");
  const target = rows.find((row) => row.move?.end === "target");

  test("draws a move as two rows naming each other", () => {
    expect(source?.move?.counterpartKey).toBe(target?.key);
    expect(target?.move?.counterpartKey).toBe(source?.key);
    expect(source?.after).toBeNull();
    expect(target?.before).toBeNull();
  });

  test("keeps each end's own wording, with the rewording it carried", () => {
    expect(textOf(source?.before ?? null)).toBe(moving);
    expect(textOf(target?.after ?? null)).toBe(reworded);
    expect(segmentTypes(source?.before)).toContain("del");
    expect(segmentTypes(target?.after)).toContain("ins");
  });

  test("names the provision at each end", () => {
    const locations = locateCompareRows(groupCompareRows(rows));

    expect(locations.get(source?.key ?? "")?.provision).toBe("§ 1");
    expect(locations.get(target?.key ?? "")?.provision).toBe("§ 3");
  });

  // Publishers print the caption above the designation or below it.
  for (const [order, printed] of [
    ["caption below", "§ 5\nDelivery"],
    ["caption above", "Delivery\n§ 5"],
  ] as const) {
    test(`names a captioned provision by its designation: ${order}`, () => {
      const blocks = [heading(printed), text("(1) The seller delivers.")];
      const locations = locateCompareRows(
        groupCompareRows(rowsOf(blocks, blocks)),
      );

      expect([...locations.values()].map((at) => at.provision)).toEqual([
        "§ 5",
        "§ 5",
      ]);
    });
  }
});

describe("pairCompareSides", () => {
  const blocks = [text("(1) Wording.")];

  test("waits for both sides", () => {
    expect(
      pairCompareSides({
        newer: { type: "ready", blocks },
        older: { type: "loading" },
      }).type,
    ).toBe("loading");
  });

  test("shows a provision one consolidation lacks one-sided", () => {
    expect(
      pairCompareSides({
        newer: { type: "ready", blocks },
        older: { type: "absent" },
      }),
    ).toEqual({ type: "newerOnly", blocks });
    expect(
      pairCompareSides({
        newer: { type: "absent" },
        older: { type: "ready", blocks },
      }),
    ).toEqual({ type: "olderOnly", blocks });
    expect(
      pairCompareSides({ newer: { type: "absent" }, older: { type: "absent" } })
        .type,
    ).toBe("neither");
  });
});

describe("a consolidation without a usable AST", () => {
  const blocks = [text("(1) Wording.")];
  const unstructured = { type: "unstructured" } as const;

  // The reader prints such a consolidation's plain text; read as an empty
  // act, the other side would be listed as added or deleted whole, and two
  // of them would read as identical.
  test("is unstructured, never an empty act", () => {
    expect(actCompareSide({ blocks: null, statuteTitle: "Act" })).toEqual(
      unstructured,
    );
    expect(actCompareSide({ blocks: [], statuteTitle: "Act" })).toEqual(
      unstructured,
    );
    expect(provisionCompareSide({ blocks: null, provision: "par_1" })).toEqual(
      unstructured,
    );
  });

  test("settles the comparison whatever the other side answers", () => {
    for (const other of [
      { type: "loading" },
      { type: "absent" },
      { type: "ready", blocks },
      unstructured,
    ] as const) {
      expect(pairCompareSides({ newer: unstructured, older: other })).toEqual(
        unstructured,
      );
      expect(pairCompareSides({ newer: other, older: unstructured })).toEqual(
        unstructured,
      );
    }
  });
});

describe("one provision compared", () => {
  const body: Block = {
    type: "paragraph",
    id: "b2",
    anchorId: "par_5-odst_1",
    inlines: [{ type: "text", text: "(1) The seller shall deliver." }],
    plainText: "(1) The seller shall deliver.",
  };
  const onScreen: Block[] = [
    {
      type: "heading",
      id: "b1",
      anchorId: "par_5",
      level: 4,
      inlines: [
        { type: "text", text: "§ 5" },
        { type: "line-break" },
        { type: "text", text: "Delivery" },
      ],
      plainText: "§ 5\nDelivery",
    },
    body,
  ];
  const readSide = (caption: string) =>
    provisionWordingSide({
      heading: {
        anchorId: "par_5",
        id: "b1",
        level: 4,
        text: `§ 5\n${caption}`,
      },
      blocks: [{ anchorId: body.anchorId, id: body.id, text: body.plainText }],
    });
  const rowsBetween = (older: CompareSideState, newer: CompareSideState) => {
    const paired = pairCompareSides({ newer, older });
    if (paired.type !== "both") {
      throw new Error(`Expected both sides, got ${paired.type}`);
    }
    return rowsOf(paired.older, paired.newer);
  };

  // The provision read never repeats the heading among its blocks, so a
  // side built from the blocks alone misses an amended caption.
  test("an amendment to the caption alone is a change", () => {
    const rows = rowsBetween(
      provisionCompareSide({ blocks: onScreen, provision: "par_5" }),
      readSide("Delivery and acceptance"),
    );

    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["heading", "changed"],
      ["text", "unchanged"],
    ]);
  });

  test("the side on screen reads as the provision read does", () => {
    expect(
      rowsBetween(
        provisionCompareSide({ blocks: onScreen, provision: "par_5" }),
        readSide("Delivery"),
      ).every((row) => row.status === "unchanged"),
    ).toBe(true);
  });
});

describe("resolveCompareVersions", () => {
  const versions = [
    { id: "c", versionValidFrom: "2026-01-01" },
    { id: "b", versionValidFrom: "2025-01-01" },
    { id: "a", versionValidFrom: "2024-01-01" },
  ];

  test("puts the older consolidation on the left whichever one was picked", () => {
    const picked = resolveCompareVersions({
      compare: "2024-01-01",
      onScreenId: "c",
      versions,
    });
    const reversed = resolveCompareVersions({
      compare: "2026-01-01",
      onScreenId: "a",
      versions,
    });

    for (const resolved of [picked, reversed]) {
      expect(resolved.type).toBe("ready");
      if (resolved.type === "ready") {
        expect(resolved.older.id).toBe("a");
        expect(resolved.newer.id).toBe("c");
      }
    }
  });

  test("names the consolidation the URL asked for as the other one", () => {
    const resolved = resolveCompareVersions({
      compare: "2025-01-01",
      onScreenId: "c",
      versions,
    });

    expect(resolved.type === "ready" && resolved.other.id).toBe("b");
  });

  test("reports a day no consolidation opened on", () => {
    expect(
      resolveCompareVersions({
        compare: "2023-05-05",
        onScreenId: "c",
        versions,
      }).type,
    ).toBe("missing");
  });

  test("reports the version on screen compared with itself", () => {
    expect(
      resolveCompareVersions({
        compare: "2026-01-01",
        onScreenId: "c",
        versions,
      }).type,
    ).toBe("same");
  });
});

/** The shape of a row: one-sided, or paired and changed or not. */
const rowShape = (row: StatuteCompareRow) => {
  if (row.before === null) {
    return "inserted";
  }
  if (row.after === null) {
    return "deleted";
  }
  return row.status;
};

/** A generated item's label and wording, split at its first space. */
const labelled = (side: StatuteCompareSide | null) => {
  const whole = textOf(side) ?? "";
  const space = whole.indexOf(" ");

  return { label: whole.slice(0, space), body: whole.slice(space) };
};

const markedText = (
  side: StatuteCompareSide | null,
  type: "del" | "ins",
): string =>
  (side?.segments ?? [])
    .filter((segment) => segment.type === type)
    .map((segment) => segment.text)
    .join("")
    .trim();

const wordsOf = (value: string): string[] =>
  value.match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The words a side marks, in order. Where the whitespace and punctuation
 * between a marked sentence and its neighbour fall is the word diff's choice;
 * which words it marks is the contract.
 */
const markedWords = (
  side: StatuteCompareSide | null,
  type: "del" | "ins",
): string[] =>
  (side?.segments ?? [])
    .filter((segment) => segment.type === type)
    .flatMap((segment) => wordsOf(segment.text));

// Each item speaks its own vocabulary, so no two items read alike.
const itemBody = (item: number): string =>
  `stanoví postup ${Array.from({ length: 5 }, (_, word) => `s${item}w${word}`).join(" ")},`;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

const letter = (index: number): string =>
  index < LETTERS.length
    ? (LETTERS.at(index) ?? "")
    : `${LETTERS.at(Math.floor(index / LETTERS.length) - 1) ?? ""}${LETTERS.at(index % LETTERS.length) ?? ""}`;

/** A list lettered in order: `a) …`, `b) …`. */
const letteredList = (items: readonly number[]): Block[] =>
  items.map((item, index) => text(`${letter(index)}) ${itemBody(item)}`));

const listInsertion = fc.integer({ min: 1, max: 12 }).chain((count) =>
  fc.record({
    count: fc.constant(count),
    positions: fc.array(fc.nat({ max: count + 4 }), {
      minLength: 1,
      maxLength: 4,
    }),
  }),
);

type ListRevision = { older: Block[]; newer: Block[]; inserted: number };

const insertItems = ({
  count,
  positions,
}: {
  count: number;
  positions: readonly number[];
}): ListRevision => {
  const original = Array.from({ length: count }, (_, item) => item);
  const revised = [...original];
  for (const [ordinal, position] of positions.entries()) {
    revised.splice(position % (revised.length + 1), 0, count + ordinal);
  }
  return {
    older: [heading("§ 1"), ...letteredList(original)],
    newer: [heading("§ 1"), ...letteredList(revised)],
    inserted: positions.length,
  };
};

// Sentences share no word, so the word diff has one way to mark the change.
const sentences = fc.uniqueArray(
  fc
    .integer({ min: 0, max: 99 })
    .map(
      (item) =>
        `${Array.from({ length: 6 }, (_, word) => `v${item}w${word}`).join(" ")}.`,
    ),
  { minLength: 2, maxLength: 5 },
);

/** Wording statutes repeat: repealed or reserved paragraphs, shared clauses. */
const repeatedBody = fc.constantFrom(
  "zrušeno",
  "Tento odstavec se nepoužije.",
  itemBody(900),
);

/**
 * Numbered paragraphs, at least one body said twice, and the paragraphs a
 * consolidation drops without renumbering the rest.
 */
const numberedWithDrops = fc
  .tuple(
    repeatedBody,
    fc.array(fc.oneof(repeatedBody, fc.nat({ max: 99 }).map(itemBody)), {
      minLength: 0,
      maxLength: 10,
    }),
    fc.nat(),
  )
  .chain(([twice, rest, at]) => {
    const bodies = [...rest];
    bodies.splice(at % (bodies.length + 1), 0, twice, twice);
    return fc.record({
      bodies: fc.constant(bodies),
      dropped: fc.uniqueArray(fc.nat({ max: bodies.length - 1 }), {
        minLength: 1,
        maxLength: bodies.length - 1,
      }),
    });
  });

describe("aligning a renumbered or extended subdivision", () => {
  test("new letters anywhere in a list read as inserted, the rest as the same wording relabelled", () => {
    fc.assert(
      fc.property(listInsertion, (edit) => {
        const { inserted, newer, older } = insertItems(edit);
        const rows = rowsOf(older, newer);
        const shapes = rows.map(rowShape);

        expect(shapes.filter((shape) => shape === "inserted")).toHaveLength(
          inserted,
        );
        expect(shapes.filter((shape) => shape === "deleted")).toHaveLength(0);
        const paired = rows.filter(
          (row) => row.before !== null && row.after !== null,
        );
        // The heading and every original letter.
        expect(paired).toHaveLength(edit.count + 1);
        for (const row of paired) {
          expect(labelled(row.after).body).toBe(labelled(row.before).body);
          // Only the label may be marked: the wording reads as it was.
          expect(markedWords(row.before, "del")).toEqual(
            row.status === "changed" ? wordsOf(labelled(row.before).label) : [],
          );
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 200 }),
    );
  });

  test("a sentence added to or dropped from a paragraph marks exactly that sentence", () => {
    fc.assert(
      fc.property(sentences, fc.nat(), (wording, pick) => {
        const at = pick % wording.length;
        const shorter = wording.filter((_, index) => index !== at);
        const paragraph = (parts: readonly string[]) =>
          text(`(8) ${parts.join(" ")}`);
        const surrounding = text(`(7) ${itemBody(500)}`);
        const added = rowsOf(
          [surrounding, paragraph(shorter)],
          [surrounding, paragraph(wording)],
        );
        const dropped = rowsOf(
          [surrounding, paragraph(wording)],
          [surrounding, paragraph(shorter)],
        );

        for (const [rows, side, type] of [
          [added, "after", "ins"],
          [dropped, "before", "del"],
        ] as const) {
          const changed = rows.filter((row) => row.status === "changed");
          expect(changed.map(rowShape)).toEqual(["changed"]);
          expect(markedWords(changed[0]?.[side] ?? null, type)).toEqual(
            wordsOf(wording.slice(at, at + 1).join("")),
          );
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 200 }),
    );
  });

  test("a repealed paragraph dropped beside another repealed one is the one deleted", () => {
    const rows = rowsOf(
      [text("(1) zrušeno"), text("(2) zrušeno")],
      [text("(2) zrušeno")],
    );

    expect(
      rows.map((row) => [rowShape(row), textOf(row.before), textOf(row.after)]),
    ).toEqual([
      ["deleted", "(1) zrušeno", null],
      ["unchanged", "(2) zrušeno", "(2) zrušeno"],
    ]);
  });

  test("a repealed paragraph dropped beside another repealed one is the one deleted under a renumbered heading", () => {
    const rows = rowsOf(
      [heading("§ 5"), text("(1) zrušeno"), text("(2) zrušeno")],
      [heading("§ 6"), text("(2) zrušeno")],
    );

    expect(
      rows
        .filter((row) => row.type === "text")
        .map((row) => [rowShape(row), textOf(row.before), textOf(row.after)]),
    ).toEqual([
      ["deleted", "(1) zrušeno", null],
      ["unchanged", "(2) zrušeno", "(2) zrušeno"],
    ]);
  });

  test("wording another provision repeats does not stop a relabelled letter pairing with its old self", () => {
    const [first, second, third] = [itemBody(0), itemBody(1), itemBody(2)];
    const rows = rowsOf(
      [
        heading("§ 1"),
        text(`a) ${first}`),
        text(`b) ${second}`),
        heading("§ 2"),
        text(`a) ${first}`),
      ],
      [
        heading("§ 1"),
        text(`a) ${third}`),
        text(`b) ${first}`),
        text(`c) ${second}`),
        heading("§ 2"),
        text(`a) ${first}`),
      ],
    );

    expect(
      rows.map((row) => [
        rowShape(row),
        textOf(row.before),
        textOf(row.after),
        markedWords(row.before, "del"),
        markedWords(row.after, "ins"),
      ]),
    ).toEqual([
      ["unchanged", "§ 1", "§ 1", [], []],
      ["inserted", null, `a) ${third}`, [], wordsOf(`a) ${third}`)],
      ["changed", `a) ${first}`, `b) ${first}`, ["a"], ["b"]],
      ["changed", `b) ${second}`, `c) ${second}`, ["b"], ["c"]],
      ["unchanged", "§ 2", "§ 2", [], []],
      ["unchanged", `a) ${first}`, `a) ${first}`, [], []],
    ]);
  });

  test("unchanged neighbouring provisions, even ones sharing its wording, never change how an amended provision pairs", () => {
    const AMENDED = "§ 1";
    const amendedRows = (older: Block[], newer: Block[]) =>
      groupCompareRows(rowsOf(older, newer))
        .find(
          (group) =>
            group.rows[0]?.type === "heading" &&
            textOf(group.rows[0].after ?? group.rows[0].before) === AMENDED,
        )
        ?.rows.map((row) => [
          rowShape(row),
          textOf(row.before),
          textOf(row.after),
          markedText(row.before, "del"),
          markedText(row.after, "ins"),
        ]);
    const amendment = fc.oneof(
      listInsertion.map(insertItems),
      numberedWithDrops.map(({ bodies, dropped }) => {
        const all = bodies.map((body, index) =>
          text(`(${String(index + 1)}) ${body}`),
        );
        return {
          older: [heading(AMENDED), ...all],
          newer: [
            heading(AMENDED),
            ...all.filter((_, index) => !dropped.includes(index)),
          ],
        };
      }),
    );
    // Small item numbers, so neighbours say what the amended provision says.
    const neighbourBodies = fc.array(
      fc.oneof(repeatedBody, fc.nat({ max: 16 }).map(itemBody)),
      { minLength: 1, maxLength: 4 },
    );
    const neighbours = fc.array(neighbourBodies, { maxLength: 3 });
    const provisions = (lists: readonly string[][], first: number): Block[] =>
      lists.flatMap((bodies, index) => [
        heading(`§ ${String(first + index)}`),
        ...bodies.map((body, item) => text(`${letter(item)}) ${body}`)),
      ]);

    fc.assert(
      fc.property(
        amendment,
        neighbours,
        neighbours,
        ({ newer, older }, above, below) => {
          const preceding = provisions(above, 100);
          const following = provisions(below, 200);
          const alone = amendedRows(older, newer);

          expect(alone).toBeDefined();
          expect(
            amendedRows(
              [...preceding, ...older, ...following],
              [...preceding, ...newer, ...following],
            ),
          ).toEqual(alone);
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 200 }),
    );
  });

  test("paragraphs dropped or added among repeated wording keep every other paragraph paired with its own label", () => {
    fc.assert(
      fc.property(numberedWithDrops, ({ bodies, dropped }) => {
        const all = bodies.map((body, index) =>
          text(`(${String(index + 1)}) ${body}`),
        );
        const kept = all.filter((_, index) => !dropped.includes(index));
        // A body said more than once is what the label must tell apart.
        expect(new Set(bodies).size).toBeLessThan(bodies.length);

        for (const [older, newer, gone] of [
          [all, kept, "deleted"],
          [kept, all, "inserted"],
        ] as const) {
          const rows = rowsOf(older, newer);
          const shapes = rows.map(rowShape);

          expect(shapes.filter((shape) => shape === gone)).toHaveLength(
            dropped.length,
          );
          expect(
            rows
              .filter((row) => row.before !== null && row.after !== null)
              .map((row) => [rowShape(row), textOf(row.before)]),
          ).toEqual(
            kept.map((block) => [
              "unchanged",
              block.type === "paragraph" ? block.plainText : null,
            ]),
          );
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 200 }),
    );
  });

  test("identical consolidations have no changed row", () => {
    fc.assert(
      fc.property(listInsertion, (edit) => {
        const { newer } = insertItems(edit);
        expect(
          rowsOf(newer, newer).filter((row) => row.status === "changed"),
        ).toEqual([]);
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 100 }),
    );
  });

  test("swapping the consolidations swaps insertions for deletions", () => {
    fc.assert(
      fc.property(listInsertion, (edit) => {
        const { newer, older } = insertItems(edit);
        const forward = rowsOf(older, newer);
        const backward = rowsOf(newer, older);

        expect(
          backward.map((row) => ({
            before: textOf(row.after),
            after: textOf(row.before),
          })),
        ).toEqual(
          forward.map((row) => ({
            before: textOf(row.before),
            after: textOf(row.after),
          })),
        );
        expect(
          backward.map(rowShape).filter((s) => s === "deleted"),
        ).toHaveLength(
          forward.map(rowShape).filter((s) => s === "inserted").length,
        );
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 200 }),
    );
  });

  // 120/2001 Sb., § 110 odst. 7 and 8, consolidations of 1 January and
  // 1 October 2026: a new letter l) renumbers l) to n), and paragraph (8)
  // gains a sentence.
  test("reads the amendment of § 110 of the Enforcement Code as one insertion, three relabellings and one extension", () => {
    const consent =
      "(8) K platnosti zkušebního, kárného a kancelářského řádu, jakož i k postupu při vyhlašování a organizaci výběrového řízení podle § 10 je zapotřebí souhlasu ministerstva.";
    const appended =
      "O přijetí návrhu stavovského předpisu podle odstavce 7 písm. l) sněm rozhodne poté, co ministerstvo s návrhem vyslovilo předběžný souhlas.";
    const older = [
      text(
        "k) stanoví postup při vyhlašování a organizaci výběrového řízení podle § 10,",
      ),
      text(
        "l) stanoví postup při vedení, správě a provozu centrální evidence exekucí,",
      ),
      text(
        "m) stanoví podrobnosti k plnění povinnosti pořizovat a uchovávat záznamy podle § 53,",
      ),
      text("n) usnáší se o dalších věcech, které si vyhradí."),
      text(consent),
    ];
    const newer = [
      text(
        "k) stanoví postup při vyhlašování a organizaci výběrového řízení podle § 10,",
      ),
      text("l) stanoví postup při vedení, správě a provozu evidence srážek,"),
      text(
        "m) stanoví postup při vedení, správě a provozu centrální evidence exekucí,",
      ),
      text(
        "n) stanoví podrobnosti k plnění povinnosti pořizovat a uchovávat záznamy podle § 53,",
      ),
      text("o) usnáší se o dalších věcech, které si vyhradí."),
      text(`${consent} ${appended}`),
    ];
    const rows = rowsOf(older, newer);

    expect(rows.map(rowShape)).toEqual([
      "unchanged",
      "inserted",
      "changed",
      "changed",
      "changed",
      "changed",
    ]);
    expect(
      rows
        .slice(2, 5)
        .map((row) => [
          markedWords(row.before, "del"),
          markedWords(row.after, "ins"),
        ]),
    ).toEqual([
      [["l"], ["m"]],
      [["m"], ["n"]],
      [["n"], ["o"]],
    ]);
    expect(markedWords(rows[5]?.before ?? null, "del")).toEqual([]);
    expect(markedWords(rows[5]?.after ?? null, "ins")).toEqual(
      wordsOf(appended),
    );
  });
});
