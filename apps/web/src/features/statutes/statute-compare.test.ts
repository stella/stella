import { describe, expect, test } from "bun:test";

import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import type { Block } from "@stll/legal-ast/document-ast";

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
