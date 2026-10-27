import { describe, expect, test } from "bun:test";

import { blocksNestedUnder } from "./provision-preview.js";
import {
  anchorEndsWithPath,
  anchorListDepth,
  anchorListDesignator,
  anchorWithin,
  E_SBIRKA_ANCHORS,
  SLOV_LEX_ANCHORS,
  US_CODE_ANCHORS,
  wholeStatuteAnchors,
} from "./statute-anchor-scheme.js";
import type { StatuteAnchorScheme } from "./statute-anchor-scheme.js";

type Relation = { ancestor: string; anchor: string; within: boolean };

/** Each row's relation as the scheme reads it, so a failure names the row. */
const relations = (scheme: StatuteAnchorScheme, rows: readonly Relation[]) =>
  rows.map(({ ancestor, anchor }) => ({
    ancestor,
    anchor,
    within: anchorWithin(scheme, { ancestor, anchor }),
  }));

const depths = (scheme: StatuteAnchorScheme, anchors: readonly string[]) =>
  Object.fromEntries(
    anchors.map((anchor) => [anchor, anchorListDepth(scheme, anchor)] as const),
  );

describe("e-Sbírka anchors", () => {
  test("a subdivision sits under every path step before it, and nowhere else", () => {
    const rows: Relation[] = [
      { ancestor: "par_139", anchor: "par_139-odst_1", within: true },
      {
        ancestor: "par_139-odst_1-pism_b",
        anchor: "par_139-odst_1-pism_b-pism_aa",
        within: true,
      },
      {
        ancestor: "par_139-odst_1",
        anchor: "par_139-odst_1-pism_b-pism_aa",
        within: true,
      },
      // A number that merely extends its sibling's is no child of it.
      { ancestor: "par_898-odst_2", anchor: "par_898-odst_20", within: false },
      // A restated subdivision is the same one stated twice.
      { ancestor: "par_2-pism_c", anchor: "par_2-pism_c~2", within: false },
      { ancestor: "par_9", anchor: "par_9", within: false },
      // Another publisher's separator continues no e-Sbírka path.
      { ancestor: "par_1", anchor: "par_1/a", within: false },
    ];
    expect(relations(E_SBIRKA_ANCHORS, rows)).toEqual(rows);
  });

  test("a letter in a letter sits one level under it, and a point under both", () => {
    expect(
      depths(E_SBIRKA_ANCHORS, [
        "par_139-odst_1",
        "par_139-odst_1-pism_b",
        "par_139-odst_1-pism_b-pism_aa",
        "par_139-odst_1-pism_b-pism_aa-bod_1",
        "par_11-odst_2-pism_b-bod_1",
        "par_5-bod_3",
        "par_2-odst_1-pism_c~2",
      ]),
    ).toEqual({
      "par_139-odst_1": null,
      "par_139-odst_1-pism_b": 1,
      "par_139-odst_1-pism_b-pism_aa": 2,
      "par_139-odst_1-pism_b-pism_aa-bod_1": 3,
      "par_11-odst_2-pism_b-bod_1": 2,
      // A section's own point keeps a point's depth.
      "par_5-bod_3": 2,
      "par_2-odst_1-pism_c~2": 1,
    });
  });

  test("names the designator of the item an anchor ends in", () => {
    expect(
      anchorListDesignator(E_SBIRKA_ANCHORS, "par_139-odst_1-pism_b-pism_aa"),
    ).toBe("aa");
    expect(
      anchorListDesignator(E_SBIRKA_ANCHORS, "par_2-odst_1-pism_c~2"),
    ).toBe("c");
    expect(
      anchorListDesignator(E_SBIRKA_ANCHORS, "par_2-odst_1-pism_a-table_1"),
    ).toBeNull();
  });

  test("an annex's local id is a whole-segment tail of its filed anchor", () => {
    expect(
      anchorEndsWithPath(E_SBIRKA_ANCHORS, {
        anchor: "prilohy-cl_7",
        tail: "cl_7",
      }),
    ).toBe(true);
    expect(
      anchorEndsWithPath(E_SBIRKA_ANCHORS, {
        anchor: "prilohy-cl_17",
        tail: "cl_7",
      }),
    ).toBe(false);
  });
});

describe("Slov-Lex anchors", () => {
  test("a letter owns its points, and a point its sub-points", () => {
    const rows: Relation[] = [
      {
        ancestor: "paragraf-36",
        anchor: "paragraf-36.pismeno-a",
        within: true,
      },
      {
        ancestor: "paragraf-15.pismeno-b",
        anchor: "paragraf-15.pismeno-b.bod-1",
        within: true,
      },
      {
        ancestor: "paragraf-15.pismeno-b.bod-1",
        anchor: "paragraf-15.pismeno-b.bod-1.bod-1a",
        within: true,
      },
      // `bod-1a` is a sibling of `bod-1`, not under it.
      {
        ancestor: "paragraf-15.pismeno-b.bod-1",
        anchor: "paragraf-15.pismeno-b.bod-1a",
        within: false,
      },
      // The kind separator is no path step.
      { ancestor: "paragraf", anchor: "paragraf-36", within: false },
      { ancestor: "paragraf-3", anchor: "paragraf-36.odsek-1", within: false },
      // e-Sbírka's separator continues no Slov-Lex path.
      {
        ancestor: "paragraf-36",
        anchor: "paragraf-36-pismeno-a",
        within: false,
      },
    ];
    expect(relations(SLOV_LEX_ANCHORS, rows)).toEqual(rows);
  });

  test("a parser-derived table and the following descendants remain in their subdivision", () => {
    const cited = { anchorId: "paragraf-36.pismeno-a" };
    const blocks = [
      cited,
      { anchorId: "paragraf-36.pismeno-a-table_1" },
      { anchorId: "paragraf-36.pismeno-a.bod-1" },
      { anchorId: "paragraf-36.pismeno-b" },
    ];
    expect(
      blocksNestedUnder({ blocks, scheme: SLOV_LEX_ANCHORS }, cited),
    ).toEqual(blocks.slice(0, 3));
  });

  test("a sibling whose anchor only shares a prefix is not nested", () => {
    expect(
      anchorWithin(SLOV_LEX_ANCHORS, {
        ancestor: "paragraf-36",
        anchor: "paragraf-360",
      }),
    ).toBe(false);
  });

  test("each point in a point opens one more level", () => {
    expect(
      depths(SLOV_LEX_ANCHORS, [
        "paragraf-15.pismeno-b",
        "paragraf-15.pismeno-b.bod-1",
        "paragraf-15.pismeno-b.bod-1.bod-1a",
        "paragraf-439.bod-1",
        "paragraf-128.odsek-2.text2",
      ]),
    ).toEqual({
      "paragraf-15.pismeno-b": 1,
      "paragraf-15.pismeno-b.bod-1": 2,
      "paragraf-15.pismeno-b.bod-1.bod-1a": 3,
      "paragraf-439.bod-1": 1,
      "paragraf-128.odsek-2.text2": null,
    });
    expect(
      anchorListDesignator(
        SLOV_LEX_ANCHORS,
        "paragraf-15.pismeno-b.bod-1.bod-1a",
      ),
    ).toBe("1a");
  });
});

describe("US Code anchors", () => {
  test("nest on their own separator, never on a section number's hyphen", () => {
    const rows: Relation[] = [
      { ancestor: "s1983", anchor: "s1983/a/1", within: true },
      { ancestor: "s1983/a", anchor: "s1983/a/1/A", within: true },
      { ancestor: "s2000e", anchor: "s2000e-2", within: false },
      { ancestor: "s2000e-2", anchor: "s2000e-2/a", within: true },
    ];
    expect(relations(US_CODE_ANCHORS, rows)).toEqual(rows);
    expect(anchorListDepth(US_CODE_ANCHORS, "s1983/a/1")).toBeNull();
  });
});

describe("anchors read whole", () => {
  test("nest under nothing, alias nothing and name no list", () => {
    const whole = wholeStatuteAnchors("No anchor grammar.");
    expect(
      anchorWithin(whole, { ancestor: "par_1", anchor: "par_1-odst_1" }),
    ).toBe(false);
    expect(
      anchorEndsWithPath(whole, { anchor: "prilohy-cl_7", tail: "cl_7" }),
    ).toBe(false);
    expect(anchorListDepth(whole, "par_1-odst_1-pism_a")).toBeNull();
    expect(anchorListDesignator(whole, "par_1-odst_1-pism_a")).toBeNull();
  });
});
