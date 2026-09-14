import { describe, expect, test } from "bun:test";

import {
  groupProvisionsByWork,
  workTitle,
  type ProvisionRow,
} from "@/features/case-law/components/case-viewer/provisions-cited.logic";

const row = (overrides: Partial<ProvisionRow> = {}): ProvisionRow => ({
  anchor: "s13",
  jurisdiction: "CZE",
  letter: null,
  openEnded: false,
  point: null,
  section: 13,
  sectionSuffix: null,
  sentence: null,
  sentenceText: "Nárok na náhradu škody podle § 13 zákona.",
  spanStart: 100,
  subsection: null,
  unit: "section",
  versionValidFrom: null,
  workCollection: "Sb.",
  workEli: "/eli/cz/sb/1998/82",
  workIdentifier: "82/1998",
  ...overrides,
});

describe("workTitle", () => {
  test("adds the collection a citation does not carry", () => {
    expect(
      workTitle({ workCollection: "Sb.", workIdentifier: "82/1998" }),
    ).toBe("82/1998 Sb.");
  });

  test("does not repeat a collection the citation already ends in", () => {
    expect(
      workTitle({ workCollection: "Sb.", workIdentifier: "82/1998 Sb." }),
    ).toBe("82/1998 Sb.");
  });

  test("matches the collection whatever case the source stored it in", () => {
    expect(
      workTitle({ workCollection: "Sb.", workIdentifier: "82/1998 SB." }),
    ).toBe("82/1998 SB.");
  });

  test("keeps a collection that only looks like a suffix", () => {
    expect(
      workTitle({ workCollection: "Z.z.", workIdentifier: "300/2005" }),
    ).toBe("300/2005 Z.z.");
  });

  test("appends when the tail is not a separate token", () => {
    expect(workTitle({ workCollection: "Sb.", workIdentifier: "82/1998Sb." }))
      // No space before the tail: the identifier is not the citation plus the
      // abbreviation, so the abbreviation is still missing from it.
      .toBe("82/1998Sb. Sb.");
  });

  test("survives a work stored without a collection", () => {
    expect(workTitle({ workCollection: "", workIdentifier: "82/1998" })).toBe(
      "82/1998",
    );
  });
});

describe("groupProvisionsByWork", () => {
  test("states a repeated provision once, with how often it is applied", () => {
    const [work] = groupProvisionsByWork([
      row({ spanStart: 10 }),
      row({ spanStart: 40 }),
      row({ spanStart: 90 }),
    ]);

    expect(work?.title).toBe("82/1998 Sb.");
    expect(work?.provisions).toHaveLength(1);
    expect(work?.provisions[0]?.occurrences).toHaveLength(3);
    expect(
      work?.provisions[0]?.occurrences.map(
        (occurrence) => occurrence.spanStart,
      ),
    ).toEqual([10, 40, 90]);
  });

  test("keeps every passage the repeated provision was applied in", () => {
    const [work] = groupProvisionsByWork([
      row({ sentenceText: "První zmínka § 13.", spanStart: 10 }),
      row({ sentenceText: "Druhá zmínka § 13.", spanStart: 40 }),
    ]);

    expect(
      work?.provisions[0]?.occurrences.map(
        (occurrence) => occurrence.sentenceText,
      ),
    ).toEqual(["První zmínka § 13.", "Druhá zmínka § 13."]);
  });

  test("subdivisions of one section stay separate provisions", () => {
    const [work] = groupProvisionsByWork([
      row({ subsection: "2" }),
      row({ subsection: "1" }),
      row({ subsection: "1" }),
      row({ subsection: null }),
    ]);

    expect(
      work?.provisions.map((provision) => ({
        count: provision.occurrences.length,
        subsection: provision.subsection,
      })),
    ).toEqual([
      { count: 1, subsection: null },
      { count: 2, subsection: "1" },
      { count: 1, subsection: "2" },
    ]);
  });

  test("orders sections numerically, not as text", () => {
    const [work] = groupProvisionsByWork([
      row({ anchor: "s100", section: 100 }),
      row({ anchor: "s9", section: 9 }),
      row({ anchor: "s13", section: 13 }),
    ]);

    expect(work?.provisions.map((provision) => provision.section)).toEqual([
      9, 13, 100,
    ]);
  });

  test("orders an inserted section after the one it follows", () => {
    const [work] = groupProvisionsByWork([
      row({ anchor: "s265b", section: 265, sectionSuffix: "b" }),
      row({ anchor: "s265", section: 265 }),
      row({ anchor: "s265a", section: 265, sectionSuffix: "a" }),
    ]);

    expect(
      work?.provisions.map((provision) => provision.sectionSuffix),
    ).toEqual([null, "a", "b"]);
  });

  test("a reference to an earlier wording is its own provision", () => {
    const [work] = groupProvisionsByWork([
      row({ versionValidFrom: null }),
      row({ versionValidFrom: "2012-01-01" }),
      row({ versionValidFrom: "2012-01-01" }),
    ]);

    expect(work?.provisions).toHaveLength(2);
    expect(
      work?.provisions.map((provision) => provision.occurrences.length),
    ).toEqual([1, 2]);
  });

  test("works keep the order the decision first names them in", () => {
    const works = groupProvisionsByWork([
      row({
        section: 95,
        unit: "article",
        workEli: "/eli/cz/sb/1993/1",
        workIdentifier: "1/1993",
      }),
      row({}),
      row({
        section: 95,
        unit: "article",
        workEli: "/eli/cz/sb/1993/1",
        workIdentifier: "1/1993",
      }),
    ]);

    expect(works.map((work) => work.title)).toEqual([
      "1/1993 Sb.",
      "82/1998 Sb.",
    ]);
  });

  test("the same citation in two jurisdictions stays two works", () => {
    expect(
      groupProvisionsByWork([row({}), row({ jurisdiction: "SVK" })]),
    ).toHaveLength(2);
  });
});
