import { describe, expect, test } from "bun:test";

import {
  formatUsCodeReference,
  locateUsCodeCitations,
  normalizeUsCodeReference,
  parseUsCodeAnchor,
  parseUsCodeReference,
  parseUsCodeWorkIdentifier,
  usCodeAnchor,
  usCodeReference,
  usCodeWorkEli,
  usCodeWorkIdentifier,
} from "./us-code-citations";
import type { LocatedUsCodeCitation } from "./us-code-citations";

/** `42 U.S.C. 1983(a)(1) et seq.`, then the printed span it was read from. */
const read = (text: string): readonly [string, string][] =>
  locateUsCodeCitations(text).map((citation) => [
    printedCitation(citation),
    text.slice(citation.start, citation.end),
  ]);

const printedCitation = (citation: LocatedUsCodeCitation): string =>
  `${usCodeWorkIdentifier(citation.work)}${citation.path
    .map((label) => `(${label})`)
    .join("")}${citation.openEnded ? " et seq." : ""}`;

type Case = readonly [text: string, expected: readonly [string, string][]];

const expectCases = (cases: readonly Case[]): void => {
  for (const [text, expected] of cases) {
    expect({ text, found: read(text) }).toEqual({ text, found: expected });
  }
};

/**
 * Free Law Project's own examples of the two codes: the `examples` of the
 * `U.S.C.` and `C.F.R.` entries of reporters-db's `laws.json`, and the U.S.C.
 * strings of eyecite's `test_FindTest.py`. See `us-code-citations.LICENSE`.
 */
const FREE_LAW_PROJECT_CASES = [
  ["1 U.S.C. § 1", [["1 U.S.C. 1", "1 U.S.C. § 1"]]],
  ["1 U.S.C.A. § 1", [["1 U.S.C. 1", "1 U.S.C.A. § 1"]]],
  ["1 U.S.C.S. § 1", [["1 U.S.C. 1", "1 U.S.C.S. § 1"]]],
  [
    "1 U.S.C.U. §§ 1-2",
    [
      ["1 U.S.C. 1", "1 U.S.C.U. §§ 1"],
      ["1 U.S.C. 2", "2"],
    ],
  ],
  ["1 U.S.C. sec. 1", [["1 U.S.C. 1", "1 U.S.C. sec. 1"]]],
  [
    "1 U.S.C. Sections 1-2",
    [
      ["1 U.S.C. 1", "1 U.S.C. Sections 1"],
      ["1 U.S.C. 2", "2"],
    ],
  ],
  [
    "1 USC S. 1-2",
    [
      ["1 U.S.C. 1", "1 USC S. 1"],
      ["1 U.S.C. 2", "2"],
    ],
  ],
  ["1 U.S. Code §1", [["1 U.S.C. 1", "1 U.S. Code §1"]]],
  [
    "21, United States Code, Section 853",
    [["21 U.S.C. 853", "21, United States Code, Section 853"]],
  ],
  [
    "18, United States Code, Section 3500",
    [["18 U.S.C. 3500", "18, United States Code, Section 3500"]],
  ],
  [
    // The `(l)` is the source's: an OCR'd `(1)`, kept as printed.
    "18, United States Code, Section 981(a)(l)(C)",
    [
      [
        "18 U.S.C. 981(a)(l)(C)",
        "18, United States Code, Section 981(a)(l)(C)",
      ],
    ],
  ],
  ["48 C.F.R. § 38.48", [["48 C.F.R. 38.48", "48 C.F.R. § 38.48"]]],
  ["18 U. S. C. § 4241", [["18 U.S.C. 4241", "18 U. S. C. § 4241"]]],
  [
    "18 U. S. C. §§4241-4243",
    [
      ["18 U.S.C. 4241", "18 U. S. C. §§4241"],
      ["18 U.S.C. 4243", "4243"],
    ],
  ],
  [
    "42 U.S.C. § 405(r)(2) (2019)",
    [["42 U.S.C. 405(r)(2)", "42 U.S.C. § 405(r)(2)"]],
  ],
] as const satisfies readonly Case[];

/** How opinions, statutes and regulations print the two codes. */
const FORMS = [
  [
    "We have jurisdiction under 28 U.S.C. § 1291, and we reverse.",
    [["28 U.S.C. 1291", "28 U.S.C. § 1291"]],
  ],
  [
    "42 U.S.C. § 1983(a)(1)(A)",
    [["42 U.S.C. 1983(a)(1)(A)", "42 U.S.C. § 1983(a)(1)(A)"]],
  ],
  ["42 USC 1983", [["42 U.S.C. 1983", "42 USC 1983"]]],
  ["42 U.S.C. §1983", [["42 U.S.C. 1983", "42 U.S.C. §1983"]]],
  ["Title 42 U.S.C. § 1983", [["42 U.S.C. 1983", "Title 42 U.S.C. § 1983"]]],
  [
    "42 U.S.C.A. § 1983 (West 2012)",
    [["42 U.S.C. 1983", "42 U.S.C.A. § 1983"]],
  ],
  ["28 U.S.C. Sec.1782", [["28 U.S.C. 1782", "28 U.S.C. Sec.1782"]]],
  ["29 U.S.C.\n216(b)", [["29 U.S.C. 216(b)", "29 U.S.C.\n216(b)"]]],
  ["26 U.S.C. § 501(c)(3)", [["26 U.S.C. 501(c)(3)", "26 U.S.C. § 501(c)(3)"]]],
  [
    "the Act of 1967,29 U.S.C. § 621 et seq.",
    [["29 U.S.C. 621 et seq.", "29 U.S.C. § 621 et seq."]],
  ],
  [
    "21 U.S.C. [§§] 951 et seq.",
    [["21 U.S.C. 951 et seq.", "21 U.S.C. [§§] 951 et seq."]],
  ],
  [
    "Title 18, United States Code, Section § 3742(a)",
    [["18 U.S.C. 3742(a)", "Title 18, United States Code, Section § 3742(a)"]],
  ],
  [
    "in violation of Title 18,\n      United States Code, Section 1546(a).",
    [
      [
        "18 U.S.C. 1546(a)",
        "Title 18,\n      United States Code, Section 1546(a)",
      ],
    ],
  ],
  [
    "section 1983 of title 42, United States Code",
    [["42 U.S.C. 1983", "section 1983 of title 42, United States Code"]],
  ],
  [
    "Section 586 of 28 United States Code describes the duties",
    [["28 U.S.C. 586", "Section 586 of 28 United States Code"]],
  ],
  [
    "section\n          994(a)(1) of title 28, United States Code",
    [
      [
        "28 U.S.C. 994(a)(1)",
        "section\n          994(a)(1) of title 28, United States Code",
      ],
    ],
  ],
  // The Code numbers inserted sections with a hyphen, often typeset as an
  // en dash, and the dash before a number as long as the first opens a range.
  [
    "42 U. S. C. § 2000e–2(a)(1)",
    [["42 U.S.C. 2000e-2(a)(1)", "42 U. S. C. § 2000e–2(a)(1)"]],
  ],
  [
    "42 U.S.C. § 2000e-5(e)(1)",
    [["42 U.S.C. 2000e-5(e)(1)", "42 U.S.C. § 2000e-5(e)(1)"]],
  ],
  [
    "42 U.S.C. §§ 2000e–2000e-17",
    [
      ["42 U.S.C. 2000e", "42 U.S.C. §§ 2000e"],
      ["42 U.S.C. 2000e-17", "2000e-17"],
    ],
  ],
  ["15 U.S.C. § 78aaa", [["15 U.S.C. 78aaa", "15 U.S.C. § 78aaa"]]],
  ["42 U.S.C. § 300gg-11", [["42 U.S.C. 300gg-11", "42 U.S.C. § 300gg-11"]]],
  ["18 U.S.C. §§ 2261A(l)", [["18 U.S.C. 2261a(l)", "18 U.S.C. §§ 2261A(l)"]]],
  // Lists and ranges.
  [
    "42 U.S.C. §§ 1981, 1982, and 1983",
    [
      ["42 U.S.C. 1981", "42 U.S.C. §§ 1981"],
      ["42 U.S.C. 1982", "1982"],
      ["42 U.S.C. 1983", "1983"],
    ],
  ],
  [
    "15 U.S.C. §§ 78j(b), 78t(a)",
    [
      ["15 U.S.C. 78j(b)", "15 U.S.C. §§ 78j(b)"],
      ["15 U.S.C. 78t(a)", "78t(a)"],
    ],
  ],
  [
    "12 U.S.C. 2601, 2603-2605, 2607, 3353, 5511; 15 U.S.C. 1601 et seq.",
    [
      ["12 U.S.C. 2601", "12 U.S.C. 2601"],
      ["12 U.S.C. 2603", "2603"],
      ["12 U.S.C. 2605", "2605"],
      ["12 U.S.C. 2607", "2607"],
      ["12 U.S.C. 3353", "3353"],
      ["12 U.S.C. 5511", "5511"],
      ["15 U.S.C. 1601 et seq.", "15 U.S.C. 1601 et seq."],
    ],
  ],
  [
    "42 U.S.C. § 1983, 28 U.S.C. § 1331",
    [
      ["42 U.S.C. 1983", "42 U.S.C. § 1983"],
      ["28 U.S.C. 1331", "28 U.S.C. § 1331"],
    ],
  ],
  [
    "28 U.S.C. § 1291, 1 F.3d 2 (9th Cir. 1993)",
    [["28 U.S.C. 1291", "28 U.S.C. § 1291"]],
  ],
  [
    "18 U.S.C. §§ 2701, et seq",
    [["18 U.S.C. 2701 et seq.", "18 U.S.C. §§ 2701, et seq"]],
  ],
  // Coordinated paragraphs continue at the level whose label is alike.
  [
    "42 U.S.C. § 2000e-2(a)(1) and (2)",
    [
      ["42 U.S.C. 2000e-2(a)(1)", "42 U.S.C. § 2000e-2(a)(1)"],
      ["42 U.S.C. 2000e-2(a)(2)", "(2)"],
    ],
  ],
  [
    "29 U.S.C. § 203(s)(1)(A), (B)",
    [
      ["29 U.S.C. 203(s)(1)(A)", "29 U.S.C. § 203(s)(1)(A)"],
      ["29 U.S.C. 203(s)(1)(B)", "(B)"],
    ],
  ],
  [
    "42 U.S.C. § 1983(a)(2) and (d)",
    [
      ["42 U.S.C. 1983(a)(2)", "42 U.S.C. § 1983(a)(2)"],
      ["42 U.S.C. 1983(d)", "(d)"],
    ],
  ],
  // Star pagination an opinion's text carries inside a citation.
  [
    "28 U.S.C. *5§ 1782 permitting them",
    [["28 U.S.C. 1782", "28 U.S.C. *5§ 1782"]],
  ],
  // The Code of Federal Regulations.
  [
    "12 C.F.R. § 1026.18(c)(1)(i)",
    [["12 C.F.R. 1026.18(c)(1)(i)", "12 C.F.R. § 1026.18(c)(1)(i)"]],
  ],
  ["12 CFR 1026.18", [["12 C.F.R. 1026.18", "12 CFR 1026.18"]]],
  [
    "in accordance with 49\n      CFR § 40.285, an individual",
    [["49 C.F.R. 40.285", "49\n      CFR § 40.285"]],
  ],
  [
    "40 CFR 60.18(i)(4)(vii)",
    [["40 C.F.R. 60.18(i)(4)(vii)", "40 CFR 60.18(i)(4)(vii)"]],
  ],
  [
    "29 C.F.R. §§ 1910.1200, 1910.1201",
    [
      ["29 C.F.R. 1910.1200", "29 C.F.R. §§ 1910.1200"],
      ["29 C.F.R. 1910.1201", "1910.1201"],
    ],
  ],
  [
    "29 C.F.R. § § 1614.106(b)",
    [["29 C.F.R. 1614.106(b)", "29 C.F.R. § § 1614.106(b)"]],
  ],
  [
    "12 C.F.R. §§ 1026.18–1026.20",
    [
      ["12 C.F.R. 1026.18", "12 C.F.R. §§ 1026.18"],
      ["12 C.F.R. 1026.20", "1026.20"],
    ],
  ],
  [
    "Code of Federal Regulations, 40 C.F.R. § 52.21(b)(23)",
    [["40 C.F.R. 52.21(b)(23)", "40 C.F.R. § 52.21(b)(23)"]],
  ],
  // Treasury rules: title 26, a parenthesized part of the number, a
  // temporary rule's T.
  [
    "26 C.F.R. § 1.401(k)-1(a)(1)",
    [["26 C.F.R. 1.401(k)-1(a)(1)", "26 C.F.R. § 1.401(k)-1(a)(1)"]],
  ],
  [
    "Treas. Reg. § 1.401(k)-1(a)(4)(iii)",
    [
      [
        "26 C.F.R. 1.401(k)-1(a)(4)(iii)",
        "Treas. Reg. § 1.401(k)-1(a)(4)(iii)",
      ],
    ],
  ],
  [
    "Treas. Reg. § 1.367(d)-1T(c)(1)",
    [["26 C.F.R. 1.367(d)-1T(c)(1)", "Treas. Reg. § 1.367(d)-1T(c)(1)"]],
  ],
  [
    "Treas. Reg. § 301.6231(a)(6)-1(a)(2)",
    [
      [
        "26 C.F.R. 301.6231(a)(6)-1(a)(2)",
        "Treas. Reg. § 301.6231(a)(6)-1(a)(2)",
      ],
    ],
  ],
  [
    "26 C.F.R. (Treas. Reg.) § 1.170A-14(g)(6).",
    [
      [
        "26 C.F.R. 1.170A-14(g)(6)",
        "26 C.F.R. (Treas. Reg.) § 1.170A-14(g)(6)",
      ],
    ],
  ],
  [
    "See Treas. Reg.\n\n        § 1.41-3A. Promulgated",
    [["26 C.F.R. 1.41-3A", "Treas. Reg.\n\n        § 1.41-3A"]],
  ],
  [
    "Treas. Reg. § 1.482‑1(a)(1)",
    [["26 C.F.R. 1.482-1(a)(1)", "Treas. Reg. § 1.482‑1(a)(1)"]],
  ],
  // The Federal Acquisition Regulation is title 48.
  ["FAR 52.212-5(b)", [["48 C.F.R. 52.212-5(b)", "FAR 52.212-5(b)"]]],
  ["48 C.F.R. § 52.212-5", [["48 C.F.R. 52.212-5", "48 C.F.R. § 52.212-5"]]],
  // A one-digit section with letters is continued by a one-digit tail.
  ["16 U.S.C. § 1a-2(h)", [["16 U.S.C. 1a-2(h)", "16 U.S.C. § 1a-2(h)"]]],
  [
    "16 U.S.C. §§ 1-4",
    [
      ["16 U.S.C. 1", "16 U.S.C. §§ 1"],
      ["16 U.S.C. 4", "4"],
    ],
  ],
  // A citation of several sections keeps its last one before prose.
  [
    "28 U.S.C. §§ 1331 and 1343 confer jurisdiction",
    [
      ["28 U.S.C. 1331", "28 U.S.C. §§ 1331"],
      ["28 U.S.C. 1343", "1343"],
    ],
  ],
  [
    "28 U.S.C. Sections 1331 and 1343 confer jurisdiction",
    [
      ["28 U.S.C. 1331", "28 U.S.C. Sections 1331"],
      ["28 U.S.C. 1343", "1343"],
    ],
  ],
  ["42 U.S.C. §§ 1983 and 12 days", [["42 U.S.C. 1983", "42 U.S.C. §§ 1983"]]],
  // A range of paragraphs ends inside the same section.
  [
    "8 U.S.C. § 1229a(c)(6)–(7)",
    [
      ["8 U.S.C. 1229a(c)(6)", "8 U.S.C. § 1229a(c)(6)"],
      ["8 U.S.C. 1229a(c)(7)", "(7)"],
    ],
  ],
  [
    "12 C.F.R. § 1026.18(c)(1)-(3)",
    [
      ["12 C.F.R. 1026.18(c)(1)", "12 C.F.R. § 1026.18(c)(1)"],
      ["12 C.F.R. 1026.18(c)(3)", "(3)"],
    ],
  ],
  // The Department of Justice's regulations open with part 0.
  ["28 C.F.R. § 0.85(a)", [["28 C.F.R. 0.85(a)", "28 C.F.R. § 0.85(a)"]]],
] as const satisfies readonly Case[];

/** Text that is not a citation of a section of either code. */
const NOT_SECTIONS = [
  // The United States Reports, Statutes at Large, public laws, the Register.
  "Brown v. Board of Education, 347 U.S. 483 (1954)",
  "42 U.S. 1983",
  "124 Stat. 119",
  "Pub. L. No. 111-148",
  "78 Fed. Reg. 67,929",
  "1986 U.S.C.C.A.N. 3555, 3555",
  // A section with no title, which only an earlier citation could supply.
  "a § 1983 claim",
  "§§ 1983 and 1985",
  // A code named as a whole, a title, a part, a chapter, an appendix.
  "the United States Code",
  "Titles 18 and 26, United States Code",
  "15 U.S.C.",
  "12 C.F.R. pt. 1026",
  "12 C.F.R. Part 1026, Subpart C",
  "42 CFR\npt. 483 (long-term care facilities)",
  "25 C.F.R. part 2",
  "42 U.S.C. ch. 21",
  "50 U.S.C. app. § 5",
  // A CFR number without its section's point is a part, never a section.
  "12 CFR 1026",
  "3 CFR 446 (1969)",
  // Titles past the code's range.
  "99 U.S.C. § 1",
  "55 U.S.C. § 1",
  "51 C.F.R. § 1.1",
  // Names that only look like the codes.
  "L.A. County/U.S.C. Medical Center",
  "Crimv.U.S.C.I.R.",
  "U.S.C. Industries, Inc.",
  "USCIS contends",
  "the CFR Court",
  "University of Southern California (USC)",
  "as far as 52.212-5 goes",
  // Another code entirely.
  "Kan. Stat. Ann. § 21-3516(a)(2)",
  "Mass. Gen. Laws ch. 1, § 2",
  "Fla. Stat. § 120.68 (2007)",
] as const;

describe("locateUsCodeCitations", () => {
  test("reads every Free Law Project example of the two codes", () => {
    expectCases(FREE_LAW_PROJECT_CASES);
  });

  test("reads the forms opinions, statutes and regulations print", () => {
    expectCases(FORMS);
  });

  test("reads nothing that is not a section of either code", () => {
    for (const text of NOT_SECTIONS) {
      expect({ text, found: read(text) }).toEqual({ text, found: [] });
    }
  });

  test("a citation in running text keeps its place among the words", () => {
    const text =
      "Plaintiffs sued under 42 U.S.C. § 1983 and invoked 12 C.F.R. § 1026.18(c); the court applied 28 U.S.C. § 1331.";
    const found = locateUsCodeCitations(text);
    expect(found.map(({ start, end }) => text.slice(start, end))).toEqual([
      "42 U.S.C. § 1983",
      "12 C.F.R. § 1026.18(c)",
      "28 U.S.C. § 1331",
    ]);
    expect(found.map(({ start }) => start)).toEqual(
      found.map(({ start }) => start).toSorted((left, right) => left - right),
    );
  });
});

describe("work identity", () => {
  test("names the section as the corpus stores it", () => {
    const [code, regulation, treasury] = [
      "42 U.S.C. § 2000e–2(a)",
      "12 C.F.R. § 1026.18",
      "Treas. Reg. § 1.401(k)-1",
    ].map((text) => locateUsCodeCitations(text)[0]?.work);
    expect(code && usCodeWorkEli(code)).toBe("/us/usc/t42/s2000e-2");
    expect(regulation && usCodeWorkEli(regulation)).toBe(
      "https://www.ecfr.gov/current/title-12/section-1026.18",
    );
    expect(treasury && usCodeWorkEli(treasury)).toBe(
      "https://www.ecfr.gov/current/title-26/section-1.401(k)-1",
    );
  });

  test("a canonical identifier round-trips; any other text is none", () => {
    for (const identifier of [
      "42 U.S.C. 1983",
      "42 U.S.C. 2000e-2",
      "12 C.F.R. 1026.18",
      "26 C.F.R. 1.401(k)-1",
    ]) {
      const work = parseUsCodeWorkIdentifier(identifier);
      expect(work === null ? null : usCodeWorkIdentifier(work)).toBe(
        identifier,
      );
    }
    for (const other of [
      "42 U.S.C. § 1983",
      "42 USC 1983",
      "55 U.S.C. 1",
      "12 C.F.R. 1026",
      "42 U.S.C. 1983 ",
    ]) {
      expect(parseUsCodeWorkIdentifier(other)).toBeNull();
    }
  });
});

describe("references and anchors", () => {
  const referenceOf = (text: string) => {
    const [citation] = locateUsCodeCitations(text);
    return citation === undefined ? null : usCodeReference(citation);
  };

  test("a section keeps its number whole, and its path as printed", () => {
    expect(referenceOf("12 C.F.R. § 1026.18(c)(1)")).toEqual({
      unit: "section",
      section: 1026,
      sectionSuffix: ".18",
      subsection: "(c)(1)",
      letter: null,
      point: null,
      sentence: null,
      openEnded: false,
    });
    expect(referenceOf("42 U.S.C. § 2000e-2")).toMatchObject({
      section: 2000,
      sectionSuffix: "e-2",
      subsection: null,
    });
  });

  test("anchors are relative to the section and cut on `/`", () => {
    const cases = [
      ["42 U.S.C. § 1983", "s1983"],
      ["42 U.S.C. § 1983(a)(1)(A)", "s1983/a/1/A"],
      ["42 U.S.C. § 2000e-2(a)", "s2000e-2/a"],
      ["12 C.F.R. § 1026.18(c)(1)(i)", "s1026.18/c/1/i"],
      ["26 C.F.R. § 1.401(k)-1(a)(4)", "s1.401(k)-1/a/4"],
    ] as const;
    for (const [text, anchor] of cases) {
      const reference = referenceOf(text);
      expect(reference === null ? null : usCodeAnchor(reference)).toBe(anchor);
      expect(parseUsCodeAnchor(anchor)).toEqual(
        reference === null ? null : { ...reference, openEnded: false },
      );
    }
  });

  test("an anchor that is not a section path parses to nothing", () => {
    for (const anchor of ["", "1983", "s", "s1983/", "s1983/a(1)", "par_5"]) {
      expect(parseUsCodeAnchor(anchor)).toBeNull();
    }
  });

  test("normalizing keeps a reference the codes could print and refuses the rest", () => {
    const reference = referenceOf("42 U.S.C. § 1983(a) et seq.");
    expect(reference).not.toBeNull();
    if (reference === null) {
      return;
    }
    expect(normalizeUsCodeReference(reference)).toEqual(reference);
    expect(
      normalizeUsCodeReference({ ...reference, sectionSuffix: "e–2" }),
    ).toMatchObject({ sectionSuffix: "e-2" });
    expect(normalizeUsCodeReference({ ...reference, letter: "a" })).toBeNull();
    expect(
      normalizeUsCodeReference({ ...reference, unit: "article" }),
    ).toBeNull();
    expect(
      normalizeUsCodeReference({ ...reference, subsection: "a)(1" }),
    ).toBeNull();
  });

  test("a printed reference without its work parses", () => {
    expect(parseUsCodeReference("§ 1983(a)(1)")).toMatchObject({
      section: 1983,
      sectionSuffix: null,
      subsection: "(a)(1)",
    });
    expect(parseUsCodeReference("1026.18(c)")).toMatchObject({
      section: 1026,
      sectionSuffix: ".18",
      subsection: "(c)",
    });
    expect(parseUsCodeReference("§ 2000e–2")).toMatchObject({
      section: 2000,
      sectionSuffix: "e-2",
    });
    for (const other of ["", "§", "§ a", "1983 claims"]) {
      expect(parseUsCodeReference(other)).toBeNull();
    }
  });

  test("prints the reference as US courts write it", () => {
    const reference = referenceOf("12 C.F.R. § 1026.18(c)(1) et seq.");
    expect(reference === null ? null : formatUsCodeReference(reference)).toBe(
      "§ 1026.18(c)(1) et seq.",
    );
  });
});
