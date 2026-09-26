import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  extractCitations,
  extractDecisionCitations,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import type {
  DecisionCitationExtraction,
  ExtractedCitation,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { CitationScopesRejectedError } from "@/api/handlers/case-law/ingestion/citation-scopes";
import {
  countUnresolvedTargets,
  US_CITATION_OCCURRENCE_LIMIT,
} from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import type { UsCitationOccurrence } from "@/api/handlers/case-law/ingestion/us-citation-occurrences";
import { plainTextOf } from "@/api/lib/case-law/document-ast";
import type {
  Block,
  DocumentAst,
  Inline,
  ParagraphBlock,
} from "@/api/lib/case-law/document-ast";
import type { CitationOpinionScope } from "@/api/lib/legal-search/ingestion-types";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const paragraph = (
  id: string,
  content: string | Inline[],
  noteId?: string,
): ParagraphBlock => {
  const inlines: Inline[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  return {
    id,
    anchorId: id,
    type: "paragraph",
    ...(noteId === undefined
      ? {}
      : { note: { type: "footnote", label: noteId, noteId } }),
    inlines,
    plainText: plainTextOf(inlines).trim(),
  };
};

const documentOf = (blocks: Block[]): DocumentAst => ({
  version: 1,
  source: { system: "test", documentId: "d", webUrl: "", printUrl: "" },
  metadata: {
    caseNumber: null,
    ecli: null,
    court: null,
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const extract = (
  blocks: Block[],
  citationScopes?: CitationOpinionScope[],
): DecisionCitationExtraction => {
  const result = extractDecisionCitations({
    country: "USA",
    sections: blocks.map((block, index) => ({ index, text: block.plainText })),
    documentAst: documentOf(blocks),
    citationScopes,
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const textOf = (blocks: readonly Block[], occurrence: UsCitationOccurrence) => {
  const block = blocks.find(({ id }) => id === occurrence.blockId);
  return block?.type === "paragraph"
    ? plainTextOf(block.inlines).slice(occurrence.start, occurrence.end)
    : "";
};

/** An occurrence as its text, its form, what it names and its pin. */
const occurrenceReading = (
  blocks: readonly Block[],
  occurrence: UsCitationOccurrence,
): unknown[] => {
  const reading: unknown[] = [
    textOf(blocks, occurrence),
    occurrence.form,
    occurrence.target.status === "identified"
      ? occurrence.target.identifiers.map(({ value }) => value)
      : occurrence.target.reason,
  ];
  if (occurrence.pin !== undefined) {
    reading.push(occurrence.pin);
  }
  return reading;
};

const edgeOf = ({
  identifierValue,
  parallelIdentifiers = [],
}: ExtractedCitation): string[] => [
  identifierValue,
  ...parallelIdentifiers.map(({ value }) => value),
];

/** Each occurrence as its text, its form and what it names. */
const readingOf = (
  blocks: Block[],
  citationScopes?: CitationOpinionScope[],
) => {
  const { citations, occurrences } = extract(blocks, citationScopes);
  return {
    occurrences: occurrences.map((occurrence) =>
      occurrenceReading(blocks, occurrence),
    ),
    edges: citations.map(edgeOf),
  };
};

const page = (start: string, end?: string) => ({
  kind: "page",
  start,
  ...(end === undefined ? {} : { end }),
});

const BROWN = ["347 U.S. 483"];

describe("adversarial references", () => {
  test("a parallel bundle is one authority with three bases and an unplaced Id. pin", () => {
    const bundle = ["347 U.S. 483", "74 S. Ct. 686", "98 L. Ed. 873"];
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483, 74 S. Ct. 686, 98 L. Ed. 873. Id. at 495.",
        ),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", bundle],
        ["74 S. Ct. 686", "full", bundle],
        ["98 L. Ed. 873", "full", bundle],
        ["Id. at 495", "id", bundle, { raw: "495", parts: [page("495")] }],
      ],
      edges: [bundle],
    });
  });

  test("a page range and note pin never become targets", () => {
    expect(readingOf([paragraph("p", "347 U.S. 483, 495–97 & n. 12")])).toEqual(
      {
        occurrences: [
          [
            "347 U.S. 483, 495–97 & n. 12",
            "full",
            BROWN,
            {
              raw: "495–97 & n. 12",
              parts: [page("495", "97"), { kind: "footnote", start: "12" }],
              reporter: { type: "reporter-citation", value: "347 U.S. 483" },
            },
          ],
        ],
        edges: [BROWN],
      },
    );
  });

  test("statutes are not case edges", () => {
    expect(
      readingOf([
        paragraph("p", "28 U.S.C. § 1253; 42 U. S. C. § 1983; 347 U. S. 483"),
      ]),
    ).toEqual({
      occurrences: [["347 U. S. 483", "full", BROWN]],
      edges: [BROWN],
    });
  });

  test("a volume short form with two first pages in its volume abstains", () => {
    expect(
      readingOf([
        paragraph("p", "347 U.S. 483; 347 U.S. 497. 347 U.S., at 495."),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", BROWN],
        ["347 U.S. 497", "full", ["347 U.S. 497"]],
        [
          "347 U.S., at 495",
          "volume-reporter",
          "ambiguous-antecedent",
          { raw: "495", parts: [page("495")] },
        ],
      ],
      edges: [BROWN, ["347 U.S. 497"]],
    });
  });

  test("a supra binds by an exact party name", () => {
    expect(
      readingOf([
        paragraph("p", "Brown v. Board, 347 U.S. 483. Brown, supra, at 495."),
      ]).occurrences,
    ).toEqual([
      ["347 U.S. 483", "full", BROWN],
      [
        "supra, at 495",
        "supra",
        BROWN,
        {
          raw: "495",
          parts: [page("495")],
          reporter: { type: "reporter-citation", value: "347 U.S. 483" },
        },
      ],
    ]);
  });

  test("a supra matching two cases never picks the nearer", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483. Brown v. Allen, 344 U.S. 443. Brown, supra.",
        ),
      ]).occurrences.at(-1),
    ).toEqual(["supra", "supra", "ambiguous-antecedent"]);
  });

  test("a statute between a case and Id. is a barrier", () => {
    expect(
      readingOf([
        paragraph("p", "347 U.S. 483. 28 U.S.C. § 1253. Id. at 495."),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", BROWN],
        [
          "Id. at 495",
          "id",
          "authority-barrier",
          { raw: "495", parts: [page("495")] },
        ],
      ],
      edges: [BROWN],
    });
  });

  test("an Id. never reaches into another opinion", () => {
    expect(
      readingOf(
        [paragraph("m", "347 U.S. 483."), paragraph("d", "Id. at 495.")],
        [
          { opinionId: "majority", blockIds: ["m"] },
          { opinionId: "dissent", blockIds: ["d"] },
        ],
      ).occurrences.at(-1),
    ).toEqual([
      "Id. at 495",
      "id",
      "missing-antecedent",
      { raw: "495", parts: [page("495")] },
    ]);
  });

  test("note registries never leak into the body or each other", () => {
    expect(
      readingOf(
        [
          paragraph("b", "347 U.S. 483."),
          paragraph("n1", "Id. at 495. 87 A.2d 862.", "1"),
          paragraph("n2", "Id. at 865.", "2"),
        ],
        [{ opinionId: "o", blockIds: ["b", "n1", "n2"] }],
      ),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", BROWN],
        [
          "Id. at 495",
          "id",
          "missing-antecedent",
          { raw: "495", parts: [page("495")] },
        ],
        ["87 A.2d 862", "full", ["87 A.2d 862"]],
        [
          "Id. at 865",
          "id",
          "missing-antecedent",
          { raw: "865", parts: [page("865")] },
        ],
      ],
      edges: [BROWN, ["87 A.2d 862"]],
    });
  });

  test("two cases of one reporter are two authorities, and a bare supra names none", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "347 U.S. 483, 163 U.S. 537. Id. at 495. supra, at 500.",
        ),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", BROWN],
        ["163 U.S. 537", "full", ["163 U.S. 537"]],
        [
          "Id. at 495",
          "id",
          "ambiguous-antecedent",
          { raw: "495", parts: [page("495")] },
        ],
        [
          "supra, at 500",
          "supra",
          "missing-antecedent",
          { raw: "500", parts: [page("500")] },
        ],
      ],
      edges: [BROWN, ["163 U.S. 537"]],
    });
  });
});

describe("scopes", () => {
  test("paragraphs of one known opinion share their last clause", () => {
    expect(
      readingOf(
        [paragraph("a", "347 U.S. 483."), paragraph("b", "Id. at 495.")],
        [{ opinionId: "o", blockIds: ["a", "b"] }],
      ).occurrences.at(-1)?.[2],
    ).toEqual(BROWN);
  });

  test("without opinion boundaries a short form stays inside its block", () => {
    expect(
      readingOf([
        paragraph("a", "347 U.S. 483."),
        paragraph("b", "Id. at 495. 163 U.S. 537. Id."),
      ]).occurrences.map((reading) => reading.at(2)),
    ).toEqual([BROWN, "scope-unknown", ["163 U.S. 537"], ["163 U.S. 537"]]);
  });

  test("adjacent blocks of one note share it", () => {
    expect(
      readingOf(
        [
          paragraph("n1", "87 A.2d 862.", "1"),
          paragraph("n2", "Id. at 865.", "1"),
        ],
        [{ opinionId: "o", blockIds: ["n1", "n2"] }],
      ).occurrences.at(-1)?.[2],
    ).toEqual(["87 A.2d 862"]);
  });

  test("each table cell is its own registry", () => {
    const cell = (text: string) => ({
      inlines: [{ type: "text" as const, text }],
      plainText: text,
    });
    const table: Block = {
      id: "t",
      anchorId: "t",
      type: "table",
      rows: [[cell("347 U.S. 483."), cell("Id. at 495.")]],
      plainText: "347 U.S. 483.\tId. at 495.",
    };
    const { occurrences } = extract(
      [table],
      [{ opinionId: "o", blockIds: ["t"] }],
    );
    expect(
      occurrences.map(({ cell: at, target }) => [
        at,
        target.status === "identified" ? "identified" : target.reason,
      ]),
    ).toEqual([
      [{ row: 0, column: 0 }, "identified"],
      [{ row: 0, column: 1 }, "missing-antecedent"],
    ]);
  });

  test("boundaries a parser got wrong reject the record", () => {
    const blocks = [
      paragraph("a", "347 U.S. 483."),
      paragraph("b", "x"),
      paragraph("c", "Id."),
    ];
    const cases = {
      "unknown-block": [{ opinionId: "o", blockIds: ["a", "z"] }],
      "duplicate-block": [
        { opinionId: "o", blockIds: ["a"] },
        { opinionId: "p", blockIds: ["a"] },
      ],
      "duplicate-opinion": [
        { opinionId: "o", blockIds: ["a"] },
        { opinionId: "o", blockIds: ["b"] },
      ],
      "discontiguous-opinion": [{ opinionId: "o", blockIds: ["a", "c"] }],
      "empty-opinion": [{ opinionId: "o", blockIds: [] }],
    } as const;
    for (const [defect, citationScopes] of Object.entries(cases)) {
      const result = extractDecisionCitations({
        country: "USA",
        sections: [],
        documentAst: documentOf(blocks),
        citationScopes,
      });
      expect(
        Result.isError(result) &&
          result.error instanceof CitationScopesRejectedError
          ? result.error.defect
          : null,
      ).toBe(defect);
    }
  });
});

describe("reading the text", () => {
  test("a note mark after a page is not part of it", () => {
    const blocks = [
      paragraph("p", [
        { type: "text", text: "Plessy v. Ferguson, 163 U. S. 537" },
        { type: "superscript", children: [{ type: "text", text: "6" }] },
        { type: "text", text: ". Id." },
      ]),
    ];
    expect(
      readingOf(blocks).occurrences.map((reading) => reading.at(2)),
    ).toEqual([["163 U.S. 537"], ["163 U.S. 537"]]);
  });

  test("a spelling the table assigns to two reporters abstains and seeds nothing", () => {
    expect(readingOf([paragraph("p", "1 Mas. 5. Id. at 7.")])).toEqual({
      occurrences: [
        ["1 Mas. 5", "full", "ambiguous-reporter"],
        [
          "Id. at 7",
          "id",
          "authority-barrier",
          { raw: "7", parts: [page("7")] },
        ],
      ],
      edges: [],
    });
  });

  test("an unsupported reporter and a treatise are barriers, not authorities", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "347 U.S. 483. See 26 J. Psychol. 259. Id. 163 U.S. 537. Knight, Public Education (1922). Id.",
        ),
      ]).occurrences.map(([, form, target]) => [form, target]),
    ).toEqual([
      ["full", BROWN],
      ["id", "authority-barrier"],
      ["full", ["163 U.S. 537"]],
      ["id", "authority-barrier"],
    ]);
  });

  test("a case's own year parenthetical is not a barrier", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Roberts v. Boston, 59 Mass. 198, 206 (1850). Id. at 207.",
        ),
      ]).occurrences.at(-1)?.[2],
    ).toEqual(["59 Mass. 198"]);
  });

  test("merged references asserting two first pages in one reporter conflict", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "347 U.S. 483, 74 S. Ct. 686. Later: 347 U.S. 483, 75 S. Ct. 1.",
        ),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", "conflicting-parallels"],
        ["74 S. Ct. 686", "full", "conflicting-parallels"],
        ["347 U.S. 483", "full", "conflicting-parallels"],
        ["75 S. Ct. 1", "full", "conflicting-parallels"],
      ],
      edges: [],
    });
  });

  test("a decision cited twice is recorded at its latest full reference", () => {
    const { citations } = extract([
      paragraph("header", "347 U.S. 483."),
      paragraph("reasoning", "We follow 347 U. S. 483, 495."),
    ]);
    expect(citations).toEqual([
      {
        citationText: "347 U. S. 483, 495",
        sectionIndex: 1,
        citedDecisionTypeHint: null,
        identifierType: "reporter-citation",
        identifierValue: "347 U.S. 483",
        citedCourtHint: null,
        citedSheetNumber: null,
        citedDecisionDate: null,
      },
    ]);
  });

  test("abstentions are counted by reason", () => {
    const { occurrences } = extract([
      paragraph("p", "347 U.S. 483, 163 U.S. 537. Id. supra."),
    ]);
    expect(countUnresolvedTargets(occurrences)).toEqual({
      "missing-antecedent": 1,
      "ambiguous-antecedent": 1,
      "ambiguous-reporter": 0,
      "authority-barrier": 0,
      "scope-unknown": 0,
      "conflicting-parallels": 0,
    });
  });
});

describe("bounds", () => {
  test("a decision past the occurrence limit is rejected, not truncated", () => {
    const text = `347 U.S. 483. ${"Id. ".repeat(US_CITATION_OCCURRENCE_LIMIT)}`;
    const result = extractDecisionCitations({
      country: "USA",
      sections: [],
      documentAst: documentOf([paragraph("p", text)]),
    });
    expect(Result.isError(result) ? result.error._tag : "accepted").toBe(
      "UsCitationOccurrenceOverflowError",
    );
  });
});

describe("a reporter-citing decision without an AST", () => {
  test("is reported unread, not as citing nothing", () => {
    const result = extractDecisionCitations({
      country: "USA",
      sections: [{ index: 0, text: "347 U.S. 483." }],
    });
    expect(Result.isOk(result) ? result.value.reading : null).toEqual({
      type: "ast-unavailable",
    });
  });
});

describe("other countries", () => {
  test("read exactly as the pattern extractor reads them", () => {
    const sections = [
      {
        index: 0,
        text: "Viz rozsudek sp. zn. 21 Cdo 1234/2019 a nález sp. zn. Pl. ÚS 18/01.",
      },
      {
        index: 1,
        text: "Wyrok z dnia 5 maja 2010 r., sygn. akt II CSK 123/20; 347 U.S. 483.",
      },
    ];
    for (const country of ["CZE", "POL", "SVK"]) {
      const result = extractDecisionCitations({ country, sections });
      expect(Result.isOk(result) ? result.value : null).toEqual({
        citations: extractCitations(sections),
        occurrences: [],
        documentAst: undefined,
        reading: { type: "patterns" },
      });
    }
  });
});

describe("a printed name on a volume short form", () => {
  test("that matches nothing abstains instead of being ignored", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483. Jones, 347 U.S., at 495.",
        ),
      ]).occurrences.at(-1)?.[2],
    ).toBe("missing-antecedent");
  });

  test("picks the one case of its volume it names", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483. Allen v. Smith, 347 U.S. 497. Brown, 347 U.S., at 490.",
        ),
      ]).occurrences.at(-1)?.[2],
    ).toEqual(BROWN);
  });

  test("keeps a parallel's name after a later single-reporter repetition", () => {
    const bundle = ["347 U.S. 483", "74 S. Ct. 686"];
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483, 74 S. Ct. 686. Later, see 347 U.S. 483. Brown, 74 S. Ct., at 690.",
        ),
      ]).occurrences.at(-1),
    ).toEqual([
      "74 S. Ct., at 690",
      "volume-reporter",
      bundle,
      {
        raw: "690",
        parts: [page("690")],
        reporter: { type: "reporter-citation", value: "74 S. Ct. 686" },
      },
    ]);
  });
});

describe("case captions", () => {
  test("two captions on one first page conflict everywhere they reach", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483. Brown v. Allen, 347 U.S. 483. Brown, supra.",
        ),
      ]),
    ).toEqual({
      occurrences: [
        ["347 U.S. 483", "full", "conflicting-parallels"],
        ["347 U.S. 483", "full", "conflicting-parallels"],
        ["supra", "supra", "conflicting-parallels"],
      ],
      edges: [],
    });
  });

  test("a shared generic party does not reconcile two captions", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "United States v. Jones, 1 U.S. 1. United States v. Smith, 1 U.S. 1. Id.",
        ),
      ]).occurrences.map((reading) => reading.at(2)),
    ).toEqual([
      "conflicting-parallels",
      "conflicting-parallels",
      "conflicting-parallels",
    ]);
  });

  test("a generic party is no name to borrow by", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "United States v. Jones, 1 U.S. 1. United States, supra.",
        ),
      ]).occurrences.at(-1)?.[2],
    ).toBe("missing-antecedent");
  });

  test("the same caption repeated is one decision", () => {
    expect(
      readingOf([
        paragraph(
          "p",
          "Brown v. Board, 347 U.S. 483. Brown v. Board, 347 U.S. 483, 495. Brown, supra.",
        ),
      ]).occurrences.map((reading) => reading.at(2)),
    ).toEqual([BROWN, BROWN, BROWN]);
  });
});

describe("authority barriers", () => {
  const cases = {
    electronic: "2020 WL 1234567",
    "electronic with a court": "2019 U.S. Dist. LEXIS 12345",
    "periodless abbreviation": "123 XYZ 456",
    "page past any reporter": "347 U.S. 1234567",
    "unsupported dotted reporter": "26 J. Psychol. 259",
    statute: "42 U.S.C. § 1983",
  } as const;

  test("stop Id. whether or not any table carries them", () => {
    for (const [name, barrier] of Object.entries(cases)) {
      const blocks = [paragraph("p", `347 U.S. 483. ${barrier}. Id. at 495.`)];
      expect({
        name,
        target: readingOf(blocks).occurrences.at(-1)?.[2],
      }).toEqual({
        name,
        target: "authority-barrier",
      });
    }
  });

  test("are counted by kind", () => {
    const { reading } = extract([
      paragraph(
        "p",
        "2020 WL 1234567. 123 XYZ 456. 42 U.S.C. § 1983. Knight, Education (1922).",
      ),
    ]);
    expect(
      reading.type === "reporter-occurrences"
        ? reading.diagnostics.barriers
        : null,
    ).toEqual({
      statute: 1,
      electronic: 1,
      "unsupported-authority": 1,
      treatise: 1,
    });
  });
});

describe("pins", () => {
  const pinOf = (text: string) =>
    extract([paragraph("p", text)]).occurrences.at(0)?.pin;

  test("a list is read whole, up to eight parts", () => {
    expect(pinOf("347 U.S. 483, 495, 496, 497, 498.")?.parts).toHaveLength(4);
    expect(pinOf("347 U.S. 483, 1, 2, 3, 4, 5, 6, 7, 8.")).toEqual({
      raw: "1, 2, 3, 4, 5, 6, 7, 8",
      parts: ["1", "2", "3", "4", "5", "6", "7", "8"].map((start) =>
        page(start),
      ),
      reporter: { type: "reporter-citation", value: "347 U.S. 483" },
    });
  });

  test("a list past the bound is reported, never truncated", () => {
    const blocks = [paragraph("p", "347 U.S. 483, 1, 2, 3, 4, 5, 6, 7, 8, 9.")];
    const { occurrences, reading } = extract(blocks);
    expect(
      occurrences.map((occurrence) => occurrenceReading(blocks, occurrence)),
    ).toEqual([["347 U.S. 483, 1, 2, 3, 4, 5, 6, 7, 8, 9", "full", BROWN]]);
    expect(
      reading.type === "reporter-occurrences"
        ? reading.diagnostics.overlongPins
        : null,
    ).toBe(1);
  });

  test("comma and at introduce a pin after a full reference or a short form", () => {
    expect(pinOf("347 U.S. 483 at 495.")?.raw).toBe("495");
    expect(pinOf("347 U.S. 483, at 495.")?.raw).toBe("495");
    expect(
      extract([paragraph("p", "87 A.2d 862. Id., 865.")]).occurrences.at(-1)
        ?.pin,
    ).toEqual({
      raw: "865",
      parts: [page("865")],
      reporter: { type: "reporter-citation", value: "87 A.2d 862" },
    });
  });

  test("printed endpoints are kept as printed", () => {
    expect(pinOf("347 U.S. 483, 495–97, *3 & ¶¶ 4-5.")?.parts).toEqual([
      page("495", "97"),
      page("*3"),
      { kind: "paragraph", start: "4", end: "5" },
    ]);
  });
});

/** The work an extraction spent, from its diagnostics. */
const workOf = (text: string): number => {
  const { reading } = extract([paragraph("p", text)]);
  return reading.type === "reporter-occurrences"
    ? reading.diagnostics.work
    : Number.NaN;
};

/**
 * Twice the input costs at most twice the work, plus a constant, and the
 * larger input still reads its last occurrence as `last`.
 */
const expectLinearGrowth = (
  build: (times: number) => string,
  last: unknown,
): void => {
  const once = workOf(build(200));
  const twice = workOf(build(400));
  expect(once).toBeGreaterThan(200);
  expect(twice).toBeLessThanOrEqual(2 * once + 64);
  expect(
    readingOf([paragraph("p", build(400))]).occurrences.at(-1)?.[2],
  ).toEqual(last);
};

describe("work", () => {
  test("repeated captions and their short forms grow linearly", () => {
    expectLinearGrowth(
      (times) =>
        "Brown v. Board, 347 U.S. 483. Brown, supra. Brown, 347 U.S., at 5. ".repeat(
          times,
        ),
      BROWN,
    );
  });

  test("many first pages in one volume grow linearly", () => {
    expectLinearGrowth(
      (times) =>
        [
          ...Array.from(
            { length: times },
            (_, index) => `347 U.S. ${String(index + 1)}.`,
          ),
          ...Array.from(
            { length: times },
            () => "347 U.S., at 7. Brown, 347 U.S., at 7.",
          ),
        ].join(" "),
      "missing-antecedent",
    );
  });

  test("a long Id. clause grows linearly", () => {
    expectLinearGrowth(
      (times) =>
        `347 U.S. 483${Array.from({ length: times }, (_, index) => `; id. at ${String(index + 1)}`).join("")}.`,
      BROWN,
    );
  });
});

// ---------------------------------------------------------------------------
// Properties

const SPELLINGS = [
  ["U.S.", ["U.S.", "U. S.", "US"]],
  ["S. Ct.", ["S. Ct.", "S.Ct.", "Sup. Ct."]],
  ["L. Ed. 2d", ["L. Ed. 2d", "L.Ed.2d", "L. Ed.2d"]],
  ["A.2d", ["A.2d", "A. 2d"]],
  ["F. Supp.", ["F. Supp.", "F.Supp."]],
] as const;

const reference = fc
  .tuple(
    fc.integer({ min: 1, max: 999 }),
    fc.constantFrom(...SPELLINGS),
    fc.nat({ max: 2 }),
    fc.integer({ min: 1, max: 1999 }),
    fc.constantFrom(" ", "  ", " "),
  )
  .map(([volume, [edition, spellings], choice, firstPage, space]) => ({
    printed: `${String(volume)}${space}${spellings[choice % spellings.length] ?? edition} ${String(firstPage)}`,
    canonical: `${String(volume)} ${edition} ${String(firstPage)}`,
  }));

const pinText = fc.oneof(
  fc.constant(""),
  fc.integer({ min: 1, max: 2999 }).map((at) => `, ${String(at)}`),
  fc.integer({ min: 1, max: 2999 }).map((at) => `, at ${String(at)}`),
  fc
    .tuple(fc.integer({ min: 100, max: 999 }), fc.integer({ min: 10, max: 99 }))
    .map(([from, to]) => `, ${String(from)}–${String(to)} & n. 3`),
);

const targetsOf = (blocks: Block[], scopes?: CitationOpinionScope[]) =>
  extract(blocks, scopes).occurrences.map(({ form, target }) => [form, target]);

/** Authorities no supported grammar names, in every shape the scanner knows. */
const unsupportedAuthority = fc.oneof(
  fc
    .tuple(
      fc.integer({ min: 1990, max: 2030 }),
      fc.integer({ min: 1, max: 9_999_999 }),
    )
    .map(([year, number]) => `${String(year)} WL ${String(number)}`),
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.stringMatching(/^[A-Z][A-Za-z]{1,6}$/u),
      fc.integer({ min: 1, max: 9999 }),
    )
    .filter(
      ([, word]) => !/^(?:Id|US|Wall|So|Mass|Tex|Pa|Pet|Ill)$/u.test(word),
    )
    .map(
      ([volume, word, first]) => `${String(volume)} ${word} ${String(first)}`,
    ),
  fc
    .tuple(
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 100_000, max: 999_999_999 }),
    )
    .map(([volume, first]) => `${String(volume)} U.S. ${String(first)}`),
  fc
    .integer({ min: 1, max: 9999 })
    .map((section) => `42 U.S.C. § ${String(section)}`),
);

const separator = fc.constantFrom(". ", "; ", "; see ");

describe("occurrences (properties)", () => {
  test("any unsupported authority between a case and Id. stops it", () => {
    fc.assert(
      fc.property(
        reference,
        unsupportedAuthority,
        separator,
        separator,
        ({ printed }, barrier, before, after) => {
          const without = targetsOf([
            paragraph("p", `${printed}${before}Id. at 5.`),
          ]);
          expect(without.at(-1)?.[1]).toMatchObject({ status: "identified" });
          const withBarrier = targetsOf([
            paragraph("p", `${printed}${before}${barrier}${after}Id. at 5.`),
          ]);
          expect(withBarrier.at(-1)?.[1]).toEqual({
            status: "unresolved",
            reason: "authority-barrier",
          });
        },
      ),
      config(300),
    );
  });

  test("spacing and spelling variants read as the same bases", () => {
    fc.assert(
      fc.property(
        fc.array(reference, { minLength: 1, maxLength: 4 }),
        (references) => {
          const text = references
            .map(({ printed }) => `${printed}.`)
            .join(" See ");
          const { citations } = extract([paragraph("p", text)]);
          expect(
            citations.map(({ identifierValue }) => identifierValue).toSorted(),
          ).toEqual(
            [
              ...new Set(references.map(({ canonical }) => canonical)),
            ].toSorted(),
          );
        },
      ),
      config(200),
    );
  });

  test("a pin never changes what a reference names", () => {
    fc.assert(
      fc.property(reference, pinText, ({ printed }, pin) => {
        const bare = targetsOf([paragraph("p", `${printed}. Id.`)]);
        const pinned = targetsOf([
          paragraph("p", `${printed}${pin}. Id. at 7.`),
        ]);
        expect(pinned).toEqual(bare);
      }),
      config(200),
    );
  });

  test("renaming an opinion never links across opinions", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}$/u), {
          minLength: 2,
          maxLength: 2,
        }),
        reference,
        ([first = "a", second = "b"], { printed }) => {
          const blocks = [
            paragraph("one", `Brown v. Board, ${printed}.`),
            paragraph("two", "Id. Brown, supra."),
          ];
          const targets = targetsOf(blocks, [
            { opinionId: first, blockIds: ["one"] },
            { opinionId: second, blockIds: ["two"] },
          ]);
          expect(targets.slice(1).map(([, target]) => target)).toEqual([
            { status: "unresolved", reason: "missing-antecedent" },
            { status: "unresolved", reason: "missing-antecedent" },
          ]);
        },
      ),
      config(100),
    );
  });

  test("repeating a reference or its short forms adds occurrences, never edges", () => {
    fc.assert(
      fc.property(
        reference,
        fc.integer({ min: 1, max: 5 }),
        ({ printed }, times) => {
          const once = extract([paragraph("p", `${printed}.`)]);
          const repeated = extract([
            paragraph(
              "p",
              Array.from({ length: times }, () => `${printed}. Id. at 5.`).join(
                " ",
              ),
            ),
          ]);
          expect(repeated.occurrences).toHaveLength(times * 2);
          expect(
            repeated.citations.map(({ identifierValue }) => identifierValue),
          ).toEqual(
            once.citations.map(({ identifierValue }) => identifierValue),
          );
        },
      ),
      config(100),
    );
  });
});
