import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  canonicalUsReporterCitation,
  parseUsReporterReference,
} from "./us-reporter-citation";

const pinsOf = (text: string) => {
  const reference = parseUsReporterReference(text);
  return reference?.type === "full" ? reference.pins : undefined;
};

describe("full citations", () => {
  test("volume, reporter and first page are the identity", () => {
    expect(parseUsReporterReference("347 U.S. 483")).toEqual({
      type: "full",
      candidates: [
        {
          volume: "347",
          edition: "U.S.",
          page: "483",
          reporter: "United States Supreme Court Reports",
        },
      ],
      pins: [],
      nominative: null,
      parenthetical: null,
    });
    expect(canonicalUsReporterCitation("347 U.S. 483")).toBe("347 U.S. 483");
  });

  test("spacing inside an abbreviation is typography", () => {
    const spellings = [
      ["163 U. S. 537", "163 U.S. 537"],
      ["87 A. 2d 862", "87 A.2d 862"],
      ["98 L.Ed. 873", "98 L. Ed. 873"],
      ["2 L.Ed.2d 1", "2 L. Ed. 2d 1"],
      ["74 S.Ct. 686", "74 S. Ct. 686"],
      ["5 Cal.4th 1", "5 Cal. 4th 1"],
      ["100 F.Supp.2d 5", "100 F. Supp. 2d 5"],
    ] as const;
    for (const [typed, canonical] of spellings) {
      expect(canonicalUsReporterCitation(typed)).toBe(canonical);
    }
  });

  test("a publisher's variant abbreviation reads as the canonical edition", () => {
    expect(canonicalUsReporterCitation("347 US 483")).toBe("347 U.S. 483");
    expect(canonicalUsReporterCitation("10 Atl. 5")).toBe("10 A. 5");
    expect(canonicalUsReporterCitation("12 Sup. Ct. 3")).toBe("12 S. Ct. 3");
  });

  test("a spelling in another case reads through its folded form", () => {
    expect(canonicalUsReporterCitation("347 u.s. 483")).toBe("347 U.S. 483");
    expect(canonicalUsReporterCitation("98 l. ed. 873")).toBe("98 L. Ed. 873");
    expect(canonicalUsReporterCitation("87 a.2D 862")).toBe("87 A.2d 862");
  });

  test("an early nominative report with one publisher is a citation of its own", () => {
    expect(canonicalUsReporterCitation("12 Wheat. 1")).toBe("12 Wheat. 1");
    expect(canonicalUsReporterCitation("2 Black 1")).toBe("2 Black 1");
  });

  test("a parallel nominative volume inside the citation stays outside identity", () => {
    expect(parseUsReporterReference("5 U.S. (1 Cranch) 137")).toMatchObject({
      candidates: [{ volume: "5", edition: "U.S.", page: "137" }],
      nominative: "1 Cranch",
    });
    expect(canonicalUsReporterCitation("5 U. S. (1 Cranch) 137")).toBe(
      "5 U.S. 137",
    );
  });

  test("a trailing year parenthetical stays outside identity", () => {
    expect(parseUsReporterReference("347 U.S. 483 (1954)")).toMatchObject({
      candidates: [{ volume: "347", edition: "U.S.", page: "483" }],
      parenthetical: "1954",
    });
  });
});

describe("reporters that share a spelling", () => {
  test("each record a variant names is kept apart", () => {
    const reporterOf = (text: string) => {
      const reference = parseUsReporterReference(text);
      return reference?.type === "full"
        ? reference.candidates.map(({ reporter }) => reporter)
        : undefined;
    };
    const circuit = reporterOf("1 Wall. C.C 1");
    const supreme = reporterOf("1 Wall. S.C. 1");
    expect(circuit).toHaveLength(1);
    expect(supreme).toHaveLength(1);
    expect(circuit).not.toEqual(supreme);
    // The bare edition names both.
    const byName = (left: string | null, right: string | null): number =>
      String(left).localeCompare(String(right));
    expect(reporterOf("1 Wall. 1")?.toSorted(byName)).toEqual(
      [...(circuit ?? []), ...(supreme ?? [])].toSorted(byName),
    );
  });

  test("no canonical identity is claimed where the edition spelling cannot tell reporters apart", () => {
    for (const text of [
      "1 Wall. 1",
      "1 Wall. C.C 1",
      "1 Wall. S.C. 1",
      "1 Cranch 137",
      "1 Dall. 1",
      "5 Penn. 10",
    ]) {
      expect(canonicalUsReporterCitation(text)).toBeNull();
    }
  });

  test("an ambiguous spelling keeps every candidate", () => {
    const reference = parseUsReporterReference("5 Penn. 10");
    expect(reference?.type).toBe("full");
    if (reference?.type === "full") {
      expect(reference.candidates.length).toBeGreaterThan(1);
      expect(reference.candidates.map(({ edition }) => edition)).toContain(
        "Pa.",
      );
    }
  });
});

describe("pins", () => {
  test("a pin is read but never part of identity", () => {
    const pinned = [
      "347 U.S. 483, 495",
      "347 U.S. 483, at 495",
      "347 U.S. 483 at 495",
      "347 U. S. 483, 494-495",
      "347 U.S. 483, 494–95",
      "347 U.S. 483, 495 n. 11",
      "347 U.S. 483, 495, n. 11",
      "347 U.S. 483, n. 11",
      "347 U.S. 483, 495, 497",
      "347 U.S. 483, 495-96, 498 n. 3 (1954)",
    ];
    for (const text of pinned) {
      expect(canonicalUsReporterCitation(text)).toBe("347 U.S. 483");
    }
  });

  test("a pin's structure is read out", () => {
    expect(pinsOf("347 U.S. 483, 495")).toEqual([
      { raw: "495", page: "495", endPage: null, footnote: null },
    ]);
    // An abbreviated range end borrows the start's leading digits.
    expect(pinsOf("347 U.S. 483, 494–95")).toEqual([
      { raw: "494–95", page: "494", endPage: "495", footnote: null },
    ]);
    expect(pinsOf("347 U.S. 483, 1098-1102")).toMatchObject([
      { page: "1098", endPage: "1102" },
    ]);
    expect(pinsOf("347 U.S. 483, 495 n. 11")).toMatchObject([
      { page: "495", footnote: "11" },
    ]);
    expect(pinsOf("347 U.S. 483, nn. 4-5")).toMatchObject([
      { page: null, footnote: "4-5" },
    ]);
  });

  test("a list of pins keeps each pin", () => {
    expect(pinsOf("347 U.S. 483, 495, 497")?.map(({ page }) => page)).toEqual([
      "495",
      "497",
    ]);
    expect(
      pinsOf("347 U.S. 483 at 494-95, 498 n. 3")?.map(
        ({ endPage, footnote, page }) => [page, endPage, footnote],
      ),
    ).toEqual([
      ["494", "495", null],
      ["498", null, "3"],
    ]);
  });

  test("a range that does not ascend keeps its text but claims no end", () => {
    expect(pinsOf("347 U.S. 483, 199-02")).toEqual([
      { raw: "199-02", page: "199", endPage: null, footnote: null },
    ]);
    expect(pinsOf("347 U.S. 483, 500-400")).toMatchObject([
      { page: "500", endPage: null },
    ]);
  });

  test("a short form names a volume and pins but no decision", () => {
    expect(parseUsReporterReference("347 U.S., at 495")).toEqual({
      type: "short",
      volume: "347",
      editions: ["U.S."],
      pins: [{ raw: "495", page: "495", endPage: null, footnote: null }],
    });
    expect(parseUsReporterReference("347 U. S. at 495, 497")).toMatchObject({
      type: "short",
      volume: "347",
      pins: [{ page: "495" }, { page: "497" }],
    });
    expect(canonicalUsReporterCitation("347 U.S., at 495")).toBeNull();
  });
});

describe("what is not a reporter citation", () => {
  test("a statute section is not a reporter citation", () => {
    for (const text of [
      "28 U.S.C. § 1253",
      "42 U.S.C.",
      "42 U.S.C. 1983",
      "42 USC 1983",
      "42 u.s.c. 1983",
      "15 U.S.C.A. 1",
    ]) {
      expect(parseUsReporterReference(text)).toBeNull();
    }
  });

  test("an entry must be the citation and nothing else", () => {
    for (const text of [
      "Brown v. Board of Education, 347 U.S. 483",
      "347 U.S. 483 and more words",
      "347 U.S. 483a",
      "347 U.S.",
      "U.S. 483",
      "347 U.S. 483, 349 U.S. 294",
    ]) {
      expect(parseUsReporterReference(text)).toBeNull();
    }
  });

  test("an abbreviation the table does not carry is not guessed", () => {
    expect(parseUsReporterReference("12 Xyz. 34")).toBeNull();
    // South Carolina's edition, not a variant of the Supreme Court Reporter.
    expect(parseUsReporterReference("12 S.C. 34")).toBeNull();
    expect(parseUsReporterReference("12 s.c. 34")).toBeNull();
  });
});

test("any spacing of a canonical citation reads to the same identity", () => {
  const citations = [
    "347 U.S. 483",
    "98 L. Ed. 873",
    "2 L. Ed. 2d 1",
    "87 A.2d 862",
    "100 F. Supp. 3d 5",
    "5 Cal. 5th 1",
    "74 S. Ct. 686",
  ];
  const respaced = fc
    .tuple(
      fc.constantFrom(...citations),
      fc.array(fc.constantFrom("", " ", "  ", " "), {
        minLength: 40,
        maxLength: 40,
      }),
      fc.boolean(),
    )
    .map(([citation, gaps, lower]) => {
      const [volume, ...rest] = citation.split(" ");
      const page = rest.pop() ?? "";
      const edition = Array.from(rest.join(""))
        .map(
          (character, index) =>
            `${character}${/[.]/u.test(character) ? (gaps[index] ?? "") : ""}`,
        )
        .join("")
        .trim();
      const typed = `${volume ?? ""} ${edition} ${page}`;
      return { citation, typed: lower ? typed.toLowerCase() : typed };
    });
  fc.assert(
    fc.property(respaced, ({ citation, typed }) => {
      expect(canonicalUsReporterCitation(typed)).toBe(citation);
    }),
    propertyConfig(),
  );
});
