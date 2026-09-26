import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  canonicalUsReporterCitation,
  parseUsReporterReference,
} from "./us-reporter-citation";

describe("full citations", () => {
  test("volume, edition and first page are the identity", () => {
    expect(parseUsReporterReference("347 U.S. 483")).toEqual({
      type: "full",
      candidates: [{ volume: "347", edition: "U.S.", page: "483" }],
      pin: null,
      nominative: null,
      parenthetical: null,
    });
  });

  test("spacing inside an abbreviation is typography", () => {
    const spellings = [
      ["163 U. S. 537", "163 U.S. 537"],
      ["163 U.S. 537", "163 U.S. 537"],
      ["87 A. 2d 862", "87 A.2d 862"],
      ["87 A.2d 862", "87 A.2d 862"],
      ["98 L. Ed. 873", "98 L. Ed. 873"],
      ["98 L.Ed. 873", "98 L. Ed. 873"],
      ["2 L. Ed. 2d 1", "2 L. Ed. 2d 1"],
      ["2 L.Ed.2d 1", "2 L. Ed. 2d 1"],
      ["74 S.Ct. 686", "74 S. Ct. 686"],
      ["5 Cal.4th 1", "5 Cal. 4th 1"],
      ["100 F. Supp. 2d 5", "100 F. Supp. 2d 5"],
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

  test("an early nominative report is a citation of its own", () => {
    expect(canonicalUsReporterCitation("1 Cranch 137")).toBe("1 Cranch 137");
    expect(canonicalUsReporterCitation("17 Wall. 1")).toBe("17 Wall. 1");
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

  test("a spelling the edition table leaves ambiguous keeps every edition", () => {
    const reference = parseUsReporterReference("5 Penn. 10");
    expect(reference?.type).toBe("full");
    if (reference?.type === "full") {
      expect(reference.candidates.length).toBeGreaterThan(1);
      expect(reference.candidates.map(({ edition }) => edition)).toContain(
        "Pa.",
      );
    }
    expect(canonicalUsReporterCitation("5 Penn. 10")).toBeNull();
  });
});

describe("pins", () => {
  test("a pin is read but never part of identity", () => {
    const pinned = [
      "347 U.S. 483, 495",
      "347 U.S. 483, at 495",
      "347 U. S. 483, 494-495",
      "347 U.S. 483, 494–95",
      "347 U.S. 483, 495 n. 11",
      "347 U.S. 483, 495, n. 11",
      "347 U.S. 483, n. 11",
    ];
    for (const text of pinned) {
      expect(canonicalUsReporterCitation(text)).toBe("347 U.S. 483");
    }
  });

  test("a pin's structure is read out", () => {
    const pinOf = (text: string) => {
      const reference = parseUsReporterReference(text);
      return reference?.type === "full" ? reference.pin : undefined;
    };
    expect(pinOf("347 U.S. 483, 495")).toEqual({
      raw: "495",
      page: "495",
      endPage: null,
      footnote: null,
    });
    // An abbreviated range end borrows the start's leading digits.
    expect(pinOf("347 U.S. 483, 494–95")).toEqual({
      raw: "494–95",
      page: "494",
      endPage: "495",
      footnote: null,
    });
    expect(pinOf("347 U.S. 483, 1098-1102")).toMatchObject({
      page: "1098",
      endPage: "1102",
    });
    expect(pinOf("347 U.S. 483, 495 n. 11")).toMatchObject({
      page: "495",
      footnote: "11",
    });
    expect(pinOf("347 U.S. 483, nn. 4-5")).toMatchObject({
      page: null,
      footnote: "4-5",
    });
  });

  test("a short form names a volume and a pin but no decision", () => {
    expect(parseUsReporterReference("347 U.S., at 495")).toEqual({
      type: "short",
      volume: "347",
      editions: ["U.S."],
      pin: { raw: "495", page: "495", endPage: null, footnote: null },
    });
    expect(parseUsReporterReference("347 U. S. at 495")).toMatchObject({
      type: "short",
      volume: "347",
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
  });

  test("case is part of an abbreviation", () => {
    expect(parseUsReporterReference("347 u.s. 483")).toBeNull();
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
    )
    .map(([citation, gaps]) => {
      const [volume, ...rest] = citation.split(" ");
      const page = rest.pop() ?? "";
      const edition = [...rest.join("")]
        .map(
          (character, index) =>
            `${character}${/[.]/u.test(character) ? (gaps[index] ?? "") : ""}`,
        )
        .join("")
        .trim();
      return { citation, typed: `${volume ?? ""} ${edition} ${page}` };
    });
  fc.assert(
    fc.property(respaced, ({ citation, typed }) => {
      expect(canonicalUsReporterCitation(typed)).toBe(citation);
    }),
    propertyConfig(),
  );
});
