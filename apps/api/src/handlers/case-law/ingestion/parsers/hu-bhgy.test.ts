import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type {
  BlockContent,
  Document as FolioDocument,
  Footnote,
  Paragraph,
  ParagraphAlignment,
} from "@stll/docx-core/model";
/**
 * The Hungarian parser, twice over.
 *
 * The first half is fixture-free: a document is written out as folio blocks, so
 * a failure names the construct the parser read wrong rather than a decision.
 * The second half drives the two readers over decisions the publisher actually
 * served — one from each era — and asserts the AST they produce, which is the
 * only place the DOCX-versus-RTF difference is visible.
 */
import { parseDocx, table } from "@stll/folio-core/server";
import {
  DECISION_IDENTIFIER_MAX_LENGTH,
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
} from "@stll/legal-ast/decision-identifier";
import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  huDecisionDateFrom,
  huDecisionTypeFrom,
  huDocketFrom,
  parseHuBhgyDecision,
} from "@/api/handlers/case-law/ingestion/parsers/hu-bhgy";
import {
  readRtf as readRtfDocument,
  readRtfString,
} from "@/api/lib/legal-search/parsers/rtf-reader";
import {
  VISIBLE_FIELD_DOCUMENT,
  VISIBLE_RUN_CASES,
  visibleRunDocument,
} from "@/api/lib/legal-search/parsers/run-content-text.fixtures";

import {
  assertNotePath,
  furnitureRtf,
  LINE_BOUNDARIES,
  NOTE_PATHS,
  notePathDocument,
  noteTableRtf,
} from "./document-note-paths.fixtures";
import { assertRtfLineParity } from "./rtf-line-parity.fixtures";
import { inlinesToPlainText } from "./shared-inlines";

const readRtf = (input: Uint8Array) => {
  const document = readRtfDocument(input);
  assertRtfLineParity(input, document);
  return document;
};

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const CENTERED: ParagraphAlignment = "center";

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x20_0b);

type LineSpec = {
  text: string;
  bold?: boolean;
  centered?: boolean;
  footnotes?: readonly number[];
};

const paragraphOf = ({
  bold,
  centered,
  text,
  footnotes = [],
}: LineSpec): Paragraph => ({
  type: "paragraph",
  ...(centered === true ? { formatting: { alignment: CENTERED } } : {}),
  content: [
    {
      type: "run",
      ...(bold === true ? { formatting: { bold: true } } : {}),
      content: [
        { type: "text", text },
        ...footnotes.map((id) => ({ type: "footnoteRef" as const, id })),
      ],
    },
  ],
});

const documentOf = (
  lines: readonly LineSpec[],
  footnotes: readonly Footnote[] = [],
): FolioDocument => {
  const content: BlockContent[] = lines.map(paragraphOf);
  return {
    package: {
      document: { content },
      ...(footnotes.length === 0 ? {} : { footnotes: [...footnotes] }),
    },
  };
};

const parseDocument = (document: FolioDocument) =>
  parseHuBhgyDecision({
    document,
    listedCaseNumber: "Gfv.30091/2025/4",
    court: "Kúria",
    sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok?azonosito=x",
    documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/?azonosito=x",
    documentId: "3cca08de",
    statutes: [],
  });

const parse = (lines: readonly LineSpec[], footnotes?: readonly Footnote[]) =>
  parseDocument(documentOf(lines, footnotes));

const visibleDocumentParagraph = (document: FolioDocument) =>
  parseDocument({
    package: {
      ...document.package,
      document: {
        content: [
          paragraphOf({ text: "Indokolás" }),
          ...document.package.document.content,
        ],
      },
    },
  }).documentAst.blocks.find((block) => block.type === "paragraph");

test("HU field results keep visible hyphens and omit instructions", () => {
  const block = visibleDocumentParagraph(VISIBLE_FIELD_DOCUMENT);
  expect(block?.type).toBe("paragraph");
  if (block?.type !== "paragraph") {
    return;
  }
  expect(block.plainText).toBe("word\u2011word");
  expect(inlinesToPlainText(block.inlines)).toBe("word\u2011word");
});

test.each(Object.values(VISIBLE_RUN_CASES))(
  "HU run kind $item.type preserves its visible characters",
  ({ item, text }) => {
    const block = visibleDocumentParagraph(visibleRunDocument(item));
    expect(block?.type).toBe("paragraph");
    if (block?.type !== "paragraph") {
      return;
    }
    expect(block.plainText).toBe(`word${text}word`);
    expect(inlinesToPlainText(block.inlines)).toBe(`word${text}word`);
  },
);

test.each(["  ", "\t", "\u00a0", " \t\u00a0"])(
  "HU numbered paragraphs use the same normalized text axis after leading %j",
  (leading) => {
    const result = parse([
      { text: "Indokolás" },
      { text: `${leading}[31] Body  `, bold: true },
    ]);
    const block = result.documentAst.blocks.find(
      (candidate) => candidate.type === "paragraph" && candidate.number === 31,
    );
    expect(block?.plainText).toBe("Body");
    expect(
      block?.type === "paragraph"
        ? inlinesToPlainText(block.inlines)
        : undefined,
    ).toBe("Body");
    expect(block?.type === "paragraph" ? block.inlines : undefined).toEqual([
      { type: "bold", children: [{ type: "text", text: "Body" }] },
    ]);
  },
);

/** One paragraph whose lines a soft break joins, as a DOCX `w:br` does. */
const softBrokenParagraph = (lines: readonly string[]): Paragraph => ({
  type: "paragraph",
  content: lines.flatMap((text, index): Paragraph["content"] => [
    ...(index === 0
      ? []
      : [{ type: "run" as const, content: [{ type: "break" as const }] }]),
    { type: "run", content: [{ type: "text", text }] },
  ]),
});

/** A body of an `Indokolás` heading and the given paragraphs, with notes. */
const bodyOf = (
  paragraphs: readonly Paragraph[],
  footnotes: readonly Footnote[] = [],
): FolioDocument => ({
  package: {
    document: {
      content: [paragraphOf({ text: "Indokolás" }), ...paragraphs],
    },
    ...(footnotes.length === 0 ? {} : { footnotes: [...footnotes] }),
  },
});

const shapeOfBlock = (block: Block): string => {
  if (block.type === "heading") {
    return `h${block.level}:${block.role ?? ""}:${block.plainText}`;
  }
  if (block.type === "paragraph") {
    const number = block.number === undefined ? "" : `#${block.number}`;
    return `p:${block.role ?? ""}${number}:${block.plainText}`;
  }
  return `${block.type}:${block.plainText}`;
};

const shapeOf = (blocks: readonly Block[]): string[] =>
  blocks.map(shapeOfBlock);

test("custom XML wrappers retain every body and table-cell paragraph", () => {
  const document = documentOf([
    { text: "Indokolás" },
    { text: "[1] A bíróság minden szót megőriz." },
    { text: "[2] A következő bekezdés is megmarad." },
  ]);
  document.package.document.content.push(
    table({
      rows: [
        [
          {
            content: [paragraphOf({ text: "A cella teljes szövege." })],
          },
        ],
      ],
    }),
  );
  const expected = parseDocument(document).documentAst;
  const wrap = (content: BlockContent[]) =>
    ({
      type: "blockCustomXml",
      openingXml: '<w:customXml w:element="decision">',
      closingXml: "</w:customXml>",
      content,
    }) satisfies BlockContent;
  for (const depth of [1, 2, 4]) {
    let content = document.package.document.content.map(
      (block): BlockContent =>
        block.type === "table"
          ? {
              ...block,
              rows: block.rows.map((row) => ({
                ...row,
                cells: row.cells.map((cell) => ({
                  ...cell,
                  content: [wrap(cell.content)],
                })),
              })),
            }
          : block,
    );
    for (let level = 0; level < depth; level += 1) {
      content = [wrap(content)];
    }
    const wrapped = {
      ...document,
      package: {
        ...document.package,
        document: {
          ...document.package.document,
          content,
        },
      },
    };
    expect(parseDocument(wrapped).documentAst).toEqual(expected);
  }
});

// ── Dates, kinds and dockets ─────────────────────────────

describe("the decision's own date", () => {
  test("reads the spelled month the current era prints", () => {
    expect(huDecisionDateFrom("Budapest, 2025. október 1.")).toBe("2025-10-01");
    expect(huDecisionDateFrom("Győr, 2009. június 30. napján")).toBe(
      "2009-06-30",
    );
  });

  test("reads the all-numeric form the legacy era prints", () => {
    expect(huDecisionDateFrom("Budapest, 2024.05.06.")).toBe("2024-05-06");
  });

  test("a line with no date states none, rather than a guess from the year", () => {
    expect(huDecisionDateFrom("Rendelkező rész")).toBeUndefined();
    expect(huDecisionDateFrom("Budapest, 2025. brumaire 1.")).toBeUndefined();
  });
});

type HungarianDateParts = {
  year: number;
  month: number;
  day: number;
};

const spelledHungarianDate = ({ year, month, day }: HungarianDateParts) => {
  const monthName =
    month >= 1 && month <= 12
      ? new Intl.DateTimeFormat("hu-HU", {
          month: "long",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(2000, month - 1, 1)))
      : "ismeretlen";
  return { year, monthName, day };
};

const HUNGARIAN_CLOSING_SHAPES = [
  {
    name: "month marker",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `Budapest, ${year}. ${monthName} hó ${day}. napján`,
  },
  {
    name: "year and month markers",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `Budapest, ${year}. év ${monthName} hó ${day}. napján`,
  },
  {
    name: "adjectival year and month markers",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `Budapest, ${year}. évi ${monthName} hó ${day}. napján`,
  },
  {
    name: "year marker",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `Budapest, ${year}. év ${monthName} ${day}. napján`,
  },
  {
    name: "omitted place",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `, ${year}. ${monthName} ${day}.`,
  },
  {
    name: "short lowercase place",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `őr, ${year}. ${monthName} ${day}.`,
  },
  {
    name: "anonymized place with a digit",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `Helység3, ${year}. ${monthName} ${day}.`,
  },
  {
    name: "parenthesized anonymized place",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `(helység), ${year}. ${monthName} ${day}.`,
  },
  {
    name: "anonymized place without a separator",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `helység neve ${year}. ${monthName} hó ${day}. napján`,
  },
  {
    name: "indented closing",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `${"\u00a0".repeat(7)} Budapest, ${year}. ${monthName} ${day}. `,
  },
  {
    name: "bare date with an inflected day",
    render: ({
      year,
      monthName,
      day,
    }: ReturnType<typeof spelledHungarianDate>) =>
      `${year}. ${monthName} ${day}-án`,
  },
] as const;

const closingDocument = (line: string, boundary: "paragraph" | "soft-break") =>
  boundary === "paragraph"
    ? documentOf([
        { text: "Indokolás" },
        { text: "[1] A bíróság döntése." },
        { text: line },
        { text: "Dr. Példa Anna s.k." },
      ])
    : bodyOf([
        paragraphOf({ text: "Indokolás" }),
        softBrokenParagraph([
          "[1] A bíróság döntése.",
          line,
          "Dr. Példa Anna s.k.",
        ]),
      ]);

describe("Hungarian closing date shapes", () => {
  for (const shape of HUNGARIAN_CLOSING_SHAPES) {
    test.each(["paragraph", "soft-break"] as const)(
      `${shape.name} states the decision date across a %s boundary`,
      (boundary) => {
        const line = shape.render(
          spelledHungarianDate({ year: 2024, month: 6, day: 13 }),
        );
        const parsed = parseDocument(closingDocument(line, boundary));
        expect(parsed.decisionDate).toBe("2024-06-13");
        expect(parsed.documentAst.metadata.decisionDate).toBe("2024-06-13");
      },
    );
  }

  test("a closing formula ends a continued history header", () => {
    const parsed = parse([
      { text: "A bíróság" },
      {
        text: "A másodfokú bíróság neve és a jogerős határozat száma: Példa Törvényszék, 1.P.20.001/2023/2.",
      },
      { text: "[1] A bíróság döntése." },
      { text: "Pécs, 2024. február 4." },
      { text: "Dr. Példa Anna s.k. bíró" },
    ]);
    expect(parsed.decisionDate).toBe("2024-02-04");
  });

  test.each([
    ["timestamp reference", "város, időbélyegző szerint."],
    [
      "electronic timestamp reference",
      "Budapest, elektronikus dátumbélyegző szerint",
    ],
    ["empty date placeholder", "Dátum"],
    ["case summary citation", "(Kúria Kfv.IV.38.001/2020.)"],
    ["administrative attachment date", "helység1. 2024. 03.25."],
  ])("%s states no court decision date", (_name, line) => {
    expect(
      parseDocument(closingDocument(line, "paragraph")).decisionDate,
    ).toBeUndefined();
  });

  test("a certification in separate paragraphs does not date the decision", () => {
    const parsed = parse([
      { text: "Indokolás" },
      { text: "[1] A bíróság döntése." },
      { text: "A kiadmány hiteléül:" },
      { text: "Budapest, 2024. június 13." },
      { text: "Dr. Példa Anna s.k." },
    ]);
    expect(parsed.decisionDate).toBeUndefined();
  });

  test("a certification marker after a soft break excludes subsequent dated paragraphs", () => {
    const parsed = parseDocument(
      bodyOf([
        paragraphOf({ text: "Indokolás" }),
        softBrokenParagraph(["[1] A bíróság döntése.", "A kiadmány hiteléül:"]),
        paragraphOf({ text: "Budapest, 2024. június 13." }),
        paragraphOf({ text: "Dr. Példa Anna s.k." }),
      ]),
    );
    expect(parsed.decisionDate).toBeUndefined();
  });

  test("a bare date without a following signature does not date the decision", () => {
    expect(
      parse([
        { text: "Indokolás" },
        { text: "2024. június 13-án" },
        { text: "Az elsőfokú bíróság tárgyalást tartott." },
      ]).decisionDate,
    ).toBeUndefined();
  });

  test.each(["bíró", "előadó bíró", "tanácselnök", "a tanács elnöke"])(
    "a bare date before a signature bearing the %s role dates both paragraph layouts",
    (role) => {
      const signature = `Dr. Példa Anna s.k. ${role}`;
      const paragraph = parse([
        { text: "Indokolás" },
        { text: "[1] A bíróság döntése." },
        { text: "2024. június 13-án" },
        { text: signature },
      ]);
      const softBreak = parseDocument(
        bodyOf([
          paragraphOf({ text: "Indokolás" }),
          softBrokenParagraph([
            "[1] A bíróság döntése.",
            "2024. június 13-án",
            signature,
          ]),
        ]),
      );

      expect(paragraph.decisionDate).toBe("2024-06-13");
      expect(softBreak.decisionDate).toBe("2024-06-13");
    },
  );

  test("a soft-broken paragraph can open with a bare decision date", () => {
    const parsed = parseDocument(
      bodyOf([
        paragraphOf({ text: "Indokolás" }),
        softBrokenParagraph(["2024. június 13-án", "Dr. Példa Anna s.k. bíró"]),
      ]),
    );

    expect(parsed.decisionDate).toBe("2024-06-13");
    expect(parsed.documentAst.metadata.decisionDate).toBe("2024-06-13");
  });
});

const isGregorianDay = ({ year, month, day }: HungarianDateParts) => {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2) {
    return day <= (leap ? 29 : 28);
  }
  const lastDay = [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= lastDay;
};

test("Hungarian decision dates are real calendar dates stated in their source", () => {
  assertProperty(
    "Hungarian decision dates are real calendar dates stated in their source",
    fc.property(
      fc.record({
        year: fc.oneof(
          fc.integer({ min: 1900, max: 2100 }),
          fc.constantFrom(1900, 2000, 2024, 2100),
        ),
        month: fc.integer({ min: 0, max: 13 }),
        day: fc.oneof(
          fc.integer({ min: 0, max: 32 }),
          fc.constantFrom(29, 30, 31),
        ),
      }),
      (parts) => {
        const iso = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
        const expected = isGregorianDay(parts) ? iso : undefined;
        const sourceDates = new Set(expected === undefined ? [] : [expected]);
        const numeric = `${parts.year}.${parts.month}.${parts.day}.`;
        expect(huDecisionDateFrom(numeric)).toBe(expected);
        for (const shape of HUNGARIAN_CLOSING_SHAPES) {
          const line = shape.render(spelledHungarianDate(parts));
          for (const boundary of ["paragraph", "soft-break"] as const) {
            const parsed = parseDocument(closingDocument(line, boundary));
            expect(parsed.decisionDate).toBe(expected);
            if (parsed.decisionDate !== undefined) {
              expect(sourceDates.has(parsed.decisionDate)).toBe(true);
              const [year, month, day] = parsed.decisionDate
                .split("-")
                .map(Number);
              expect(year).toBeDefined();
              expect(month).toBeDefined();
              expect(day).toBeDefined();
              if (
                year !== undefined &&
                month !== undefined &&
                day !== undefined
              ) {
                expect(isGregorianDay({ year, month, day })).toBe(true);
              }
            }
          }
          const note = parse(
            [
              { text: "Indokolás" },
              { text: "[1] A bíróság döntése.", footnotes: [1] },
            ],
            [
              {
                type: "footnote",
                id: 1,
                content: [
                  paragraphOf({ text: line }),
                  paragraphOf({ text: "Dr. Példa Anna s.k." }),
                ],
              },
            ],
          );
          expect(note.decisionDate).toBeUndefined();
          const softBrokenNote = parse(
            [
              { text: "Indokolás" },
              { text: "[1] A bíróság döntése.", footnotes: [1] },
            ],
            [
              {
                type: "footnote",
                id: 1,
                content: [
                  softBrokenParagraph([
                    "Példa megjegyzés.",
                    line,
                    "Dr. Példa Anna s.k.",
                  ]),
                ],
              },
            ],
          );
          expect(softBrokenNote.decisionDate).toBeUndefined();
          const certification = parse([
            { text: "Indokolás" },
            { text: "[1] A bíróság döntése." },
            { text: "A kiadmány hiteléül:" },
            { text: line },
            { text: "Dr. Példa Anna s.k." },
          ]);
          expect(certification.decisionDate).toBeUndefined();
          const softBrokenCertification = parseDocument(
            bodyOf([
              paragraphOf({ text: "Indokolás" }),
              softBrokenParagraph([
                "[1] A bíróság döntése.",
                "A kiadmány hiteléül:",
                line,
                "Dr. Példa Anna s.k.",
              ]),
            ]),
          );
          expect(softBrokenCertification.decisionDate).toBeUndefined();
          const continuedCertification = parseDocument(
            bodyOf([
              paragraphOf({ text: "Indokolás" }),
              softBrokenParagraph([
                "[1] A bíróság döntése.",
                "A kiadmány hiteléül:",
              ]),
              paragraphOf({ text: line }),
              paragraphOf({ text: "Dr. Példa Anna s.k." }),
            ]),
          );
          expect(continuedCertification.decisionDate).toBeUndefined();
        }
      },
    ),
    { numRuns: 100 },
  );
});

describe("the decision's kind", () => {
  test("is the dictionary form, lowercase, whatever case the title prints", () => {
    expect(huDecisionTypeFrom(["A Kúria", "ítélete"])).toBe("ítélet");
    expect(huDecisionTypeFrom(["V É G Z É S T :"])).toBe("végzés");
    expect(huDecisionTypeFrom(["jogegységi határozat"])).toBe(
      "jogegységi határozat",
    );
  });

  test("a title naming no kind states none", () => {
    expect(
      huDecisionTypeFrom(["Az ügy száma: Gfv.30091/2025/4"]),
    ).toBeUndefined();
  });
});

describe("the docket the document prints", () => {
  test("is read from the labelled line of the current era", () => {
    expect(huDocketFrom(["Az ügy száma:      Gfv.VI.30.091/2025/4."])).toBe(
      "Gfv.VI.30.091/2025/4",
    );
  });

  test("is read from the `szám` line of the legacy era", () => {
    expect(huDocketFrom(["Bhar.31/2009/6. szám"])).toBe("Bhar.31/2009/6");
    expect(huDocketFrom(["Pf.III.20.723/2009/5. szám"])).toBe(
      "Pf.III.20.723/2009/5",
    );
  });

  // A header built with soft breaks instead of separate paragraphs keeps the
  // rest of the document on the label's own line, because a break renders as
  // a newline rather than ending the line. Reading the label's line to the
  // end of the block took the whole body into the docket, which the corpus
  // then refused as an identifier and parked every such decision.
  test("stops at the soft break the header paragraph carries", () => {
    const header = [
      "Az ügy száma: Kfv.VI.37.123/2025/8.",
      "A tanács tagjai: Dr. Példa Péter a tanács elnöke",
      "A felperes: Példa Kft.",
      "Az ítélet indokolása ".repeat(200),
    ].join("\n");

    // The fixture has to reach the fault: unsplit, the block is past the
    // length an identifier may have, which is what the refusal was about.
    expect(header.length).toBeGreaterThan(DECISION_IDENTIFIER_MAX_LENGTH);

    expect(huDocketFrom([header])).toBe("Kfv.VI.37.123/2025/8");
  });

  // The docket leaves this parser as a `case-number` identifier and as
  // metadata, and the corpus refuses an identifier it cannot store by
  // throwing, before the decision is written. So nothing this returns may be
  // unstorable, whatever a header prints.
  test.each([
    [
      "a header paragraph joined by soft breaks",
      `Az ügy száma: ${"x".repeat(400)}\nbody`,
    ],
    [
      "a labelled line of nothing but a long run",
      `Az ügy száma: ${"A".repeat(300)}`,
    ],
    // `trim` leaves a zero-width space, so the docket is non-empty and prints
    // as nothing. Built from its code point rather than written into the
    // string: the character is invisible in review either way.
    [
      "a labelled line of zero-width characters",
      `Az ügy száma: ${ZERO_WIDTH_SPACE.repeat(2)}`,
    ],
    ["a legacy line with a labelled line after it", "Bhar.31/2009/6. szám"],
    ["a header with no docket at all", "Rendelkező rész"],
  ])("states a storable docket or none: %s", (_case, line) => {
    const docket = huDocketFrom([line]);
    if (docket === undefined) {
      return;
    }
    expect(
      isDecisionIdentifier({
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: docket,
      }),
    ).toBe(true);
  });
});

// ── Structure ────────────────────────────────────────────

describe("reading a document folio handed over", () => {
  test("keeps visible text across fields, tracked insertions, wrappers, and nested links", () => {
    const paragraph: Paragraph = {
      type: "paragraph",
      content: [
        { type: "run", content: [{ type: "text", text: "before " }] },
        {
          type: "complexField",
          instruction: "PAGE",
          fieldType: "PAGE",
          fieldCode: [],
          fieldResult: [
            { type: "run", content: [{ type: "text", text: "field " }] },
          ],
        },
        {
          type: "simpleField",
          instruction: "PAGE",
          fieldType: "PAGE",
          content: [
            { type: "run", content: [{ type: "text", text: "simple " }] },
          ],
        },
        {
          type: "insertion",
          info: { id: 1, author: "court" },
          content: [
            { type: "run", content: [{ type: "text", text: "inserted " }] },
          ],
        },
        {
          type: "moveTo",
          info: { id: 2, author: "court" },
          content: [
            { type: "run", content: [{ type: "text", text: "moved " }] },
          ],
        },
        {
          type: "inlineSdt",
          properties: { sdtType: "richText" },
          content: [
            { type: "run", content: [{ type: "text", text: "controlled " }] },
          ],
        },
        {
          type: "inlineWrapper",
          kind: "smartTag",
          element: "name",
          content: [
            { type: "run", content: [{ type: "text", text: "wrapped " }] },
          ],
        },
        {
          type: "mathEquation",
          display: "inline",
          ommlXml: "<m:oMath><m:r><m:t>math </m:t></m:r></m:oMath>",
          plainText: "math ",
        },
        {
          type: "preservedInline",
          xml: "<opaque><w:r><w:t>preserved </w:t></w:r></opaque>",
          text: "preserved ",
        },
        {
          type: "hyperlink",
          children: [
            { type: "run", content: [{ type: "text", text: "link one " }] },
            {
              type: "inlineWrapper",
              kind: "smartTag",
              element: "linkText",
              content: [
                { type: "run", content: [{ type: "text", text: "link two " }] },
              ],
            },
            {
              type: "preservedInline",
              xml: "<opaque><w:r><w:t>link three</w:t></w:r></opaque>",
              text: "link three",
            },
          ],
        },
      ],
    };
    const parsed = parseDocument(bodyOf([paragraph]));

    expect(parsed.fulltext).toContain(
      "before field simple inserted moved controlled wrapped math preserved link one link two link three",
    );
  });

  // The same header, as the publisher actually builds it: one paragraph whose
  // runs carry `break` items, which is what an RTF `\line` reads as.
  test("a header paragraph built with soft breaks states the docket alone", () => {
    const softBreakHeader: Paragraph = {
      type: "paragraph",
      content: [
        {
          type: "run",
          content: [
            { type: "text", text: "Az ügy száma: Kfv.VI.37.123/2025/8." },
            { type: "break" },
            { type: "text", text: "A tanács tagjai: Dr. Példa Péter" },
            { type: "break" },
            { type: "text", text: "Az ítélet indokolása ".repeat(200) },
          ],
        },
      ],
    };

    const parsed = parseHuBhgyDecision({
      document: { package: { document: { content: [softBreakHeader] } } },
      listedCaseNumber: "Kfv.37123/2025/8",
      court: "Kúria",
      sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok?azonosito=x",
      documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/?azonosito=x",
      documentId: "3cca08de",
      statutes: [],
    });

    expect(parsed.documentDocket).toBe("Kfv.VI.37.123/2025/8");
  });

  test("the publisher's section headings cut the decision", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "ítélete" },
      { text: "Rendelkező rész" },
      { text: "A Kúria a jogerős ítéletet hatályában fenntartja." },
      { text: "Indokolás" },
      { text: "A felülvizsgálat alapjául szolgáló tényállás" },
      { text: "[1]\tAz alperes közgyűlése." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:decision-title:A Kúria",
      "p:intro:ítélete",
      "h1:section-heading:Rendelkező rész",
      "p:holding:A Kúria a jogerős ítéletet hatályában fenntartja.",
      "h1:section-heading:Indokolás",
      "h2:section-heading:A felülvizsgálat alapjául szolgáló tényállás",
      "p:argumentation#1:Az alperes közgyűlése.",
    ]);
  });

  test("the court's bracketed number is structure, not a prefix in the text", () => {
    const [, block] = parse([
      { text: "Indokolás" },
      { text: "[31]     A felülvizsgálati kérelem nem vezetett eredményre." },
    ]).documentAst.blocks;
    expect(block?.type).toBe("paragraph");
    expect(block?.type === "paragraph" ? block.number : null).toBe(31);
    expect(block?.plainText).toBe(
      "A felülvizsgálati kérelem nem vezetett eredményre.",
    );
  });

  test("the legacy era's spaced capitals open the operative part", () => {
    const parsed = parse([
      { text: "SZEGEDI ÍTÉLŐTÁBLA", bold: true },
      { text: "Í T É L E T E T :", bold: true, centered: true },
      { text: "Az elsőfokú bíróság ítéletét helybenhagyja." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:decision-title:SZEGEDI ÍTÉLŐTÁBLA",
      "h1:section-heading:Í T É L E T E T :",
      "p:holding:Az elsőfokú bíróság ítéletét helybenhagyja.",
    ]);
  });

  test("front-matter labels carry the role each names", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "Az ügy száma: Gfv.VI.30.091/2025/4." },
      { text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke" },
      { text: "A felperes: név1 (cím1)" },
      { text: "A felperes képviselője: Dr. Példa Ügyvédi Iroda (cím2)" },
      { text: "A per tárgya: közgyűlési határozatok hatályon kívül helyezése" },
      {
        text: "A másodfokú bíróság neve és a jogerős határozat száma: Fővárosi Ítélőtábla, 13.Gf.40.203/2024/8-II.",
      },
    ]);
    expect(
      parsed.documentAst.blocks.map((block) =>
        block.type === "paragraph" ? block.role : block.type,
      ),
    ).toEqual([
      "heading",
      "case-number",
      "panel",
      "parties",
      "counsel",
      "front-matter",
      "history",
    ]);
    expect(parsed.relatedProceedings).toHaveLength(1);
  });

  test("the panel block names the bench in the parts the court states", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke" },
      { text: "Dr. Minta Béla előadó bíró" },
      { text: "Dr. Teszt Csilla bíró" },
      { text: "A felperes: név1 (cím1)" },
      { text: "Rendelkező rész" },
      { text: "A Kúria a jogerős ítéletet hatályában fenntartja." },
    ]);
    expect(parsed.judges).toEqual([
      { role: "presiding", nameAsPrinted: "Dr. Példa Anna" },
      { role: "rapporteur", nameAsPrinted: "Dr. Minta Béla" },
      { role: "panel-member", nameAsPrinted: "Dr. Teszt Csilla" },
    ]);
  });

  test("a bench written on one line is cut on the court's own separators", () => {
    const parsed = parse([
      { text: "A Kúria" },
      {
        text: "A tanács tagjai: Dr. Példa Anna a tanács elnöke / Dr. Minta Béla előadó bíró / Dr. Teszt Csilla bíró",
      },
      { text: "Rendelkező rész" },
    ]);
    expect(parsed.judges.map(({ role }) => role)).toEqual([
      "presiding",
      "rapporteur",
      "panel-member",
    ]);
  });

  test("the header's labels are what the field inventory reads back", () => {
    const parsed = parse([
      { text: "A Kúria" },
      { text: "Az ügy száma: Gfv.VI.30.091/2025/4." },
      { text: "Az alperesek: cég1 (cím3)" },
      { text: "Az alperesek képviselője: Példa Ügyvédi Iroda" },
      { text: "Rendelkező rész" },
      // Past the header a sentence opens with the same words, and the labels
      // stop there.
      { text: "Az alperesek felülvizsgálati kérelmet nyújtottak be." },
    ]);
    expect(parsed.headerLabels).toEqual([
      "Az ügy száma",
      "Az alperes",
      "Az alperes képviselője",
    ]);
    expect(
      parsed.documentAst.blocks.map((block) =>
        block.type === "paragraph" ? block.role : block.type,
      ),
    ).toEqual([
      "heading",
      "case-number",
      "parties",
      "counsel",
      "heading",
      "holding",
    ]);
  });

  test("the closing formula dates the decision and opens the signature block", () => {
    const parsed = parse([
      { text: "Indokolás" },
      { text: "[1] A Kúria döntése." },
      { text: "Budapest, 2025. október 1." },
      { text: "Dr. Példa Anna s.k. a tanács elnöke" },
      { text: "A kiadmány hiteléül:" },
    ]);
    expect(parsed.decisionDate).toBe("2025-10-01");
    expect(shapeOf(parsed.documentAst.blocks).slice(-3)).toEqual([
      "p:closing:Budapest, 2025. október 1.",
      "p:signature:Dr. Példa Anna s.k. a tanács elnöke",
      "p:apparatus:A kiadmány hiteléül:",
    ]);
  });

  // A body paragraph can carry the closing formula after a soft break rather
  // than in a paragraph of its own; a match anchored to the paragraph's start
  // never saw it, and the decision went undated.
  test("a closing line after a soft break in a DOCX body paragraph dates the decision", () => {
    const parsed = parseDocument(
      bodyOf([
        softBrokenParagraph([
          "[1] A Kúria a jogerős ítéletet hatályában fenntartja.",
          "Budapest, 2021. március 3.",
          "Dr. Példa Anna s.k. a tanács elnöke",
        ]),
      ]),
    );
    expect(parsed.decisionDate).toBe("2021-03-03");
    expect(parsed.documentAst.metadata.decisionDate).toBe("2021-03-03");
  });

  test("a closing line after an RTF line break in a body paragraph dates the decision", () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1250\deff0{\fonttbl{\f0\froman Times;}}\pard Indokol\'e1s\par\pard A t\'e1rgyal\'e1s mell\'f5z\'e9s\'e9vel hozott v\'e9gz\'e9s.\line Gy\'f5r, 2009. j\'fanius 30. napj\'e1n\line Dr. P\'e9lda Anna s.k.\par }`;
    const parsed = parseDocument(readRtf(new TextEncoder().encode(rtf)));
    expect(parsed.readerWarnings).toEqual([]);
    expect(parsed.decisionDate).toBe("2009-06-30");
  });

  test("a closing line that opens its own paragraph wins over one after a soft break", () => {
    const parsed = parseDocument(
      bodyOf([
        softBrokenParagraph([
          "[1] Az elsőfokú bíróság ítélete:",
          "Szeged, 2019. május 5.",
        ]),
        paragraphOf({ text: "Budapest, 2021. március 3." }),
      ]),
    );
    expect(parsed.decisionDate).toBe("2021-03-03");
  });

  test("a certification that a body paragraph runs on into dates nothing", () => {
    const parsed = parseDocument(
      bodyOf([
        softBrokenParagraph([
          "[1] A Kúria a jogerős ítéletet hatályában fenntartja.",
          "A kiadmány hiteléül:",
          "Budapest, 2021. március 10.",
        ]),
      ]),
    );
    expect(parsed.decisionDate).toBeUndefined();
  });

  test("a footnote's closing-shaped line after a soft break dates nothing", () => {
    const parsed = parseDocument(
      bodyOf(
        [paragraphOf({ text: "[1] A Kúria döntése.", footnotes: [1] })],
        [
          {
            type: "footnote",
            id: 1,
            content: [
              softBrokenParagraph([
                "Az elsőfokú bíróság ítélete.",
                "Budapest, 2021. március 3.",
              ]),
            ],
          },
        ],
      ),
    );
    expect(parsed.decisionDate).toBeUndefined();
  });

  test.each([
    [
      "within a line, with no break",
      [
        "[1] Az elsőfokú bíróság ítéletét (Budapest, 2021. március 3.) helybenhagyta.",
      ],
    ],
    [
      "mid-sentence on the line after a break",
      [
        "[1] A tényállás:",
        "Az elsőfokú bíróság Budapest, 2021. március 3. napján kelt ítéletét helybenhagyta.",
      ],
    ],
  ])("a date inside running text dates nothing: %s", (_case, lines) => {
    const parsed = parseDocument(bodyOf([softBrokenParagraph(lines)]));
    expect(parsed.decisionDate).toBeUndefined();
  });

  test("a footnote is apparatus carrying its mark, wherever the body left off", () => {
    // A note may read like the document's structure; its anchor controls order
    // while its note membership keeps it out of body classification.
    const parsed = parse(
      [
        { text: "Indokolás" },
        { text: "[1] A Kúria döntése.", footnotes: [3, 4] },
        { text: "Budapest, 2025. október 1." },
        { text: "Dr. Példa Anna s.k. a tanács elnöke" },
      ],
      [
        {
          type: "footnote",
          id: 3,
          content: [paragraphOf({ text: "A Ptk. 6:1. §-a." })],
        },
        {
          type: "footnote",
          id: 4,
          content: [paragraphOf({ text: "Indokolás" })],
        },
      ],
    );
    const notes = parsed.documentAst.blocks.filter(
      (block) => block.type === "paragraph" && block.note !== undefined,
    );
    expect(notes.map(shapeOfBlock)).toEqual([
      "p:apparatus:A Ptk. 6:1. §-a.",
      "p:apparatus:Indokolás",
    ]);
    expect(notes.at(0)).toMatchObject({
      note: { type: "footnote", label: "3", noteId: "fn-3" },
    });
  });

  test("a line the parser does not recognise is still a paragraph in order", () => {
    // Rule 10: classification is a promotion from "paragraph", never a filter.
    const parsed = parse([
      { text: "Indokolás" },
      { text: "Egy mondat, amelyet a parser nem ismer fel." },
    ]);
    expect(shapeOf(parsed.documentAst.blocks)).toEqual([
      "h1:section-heading:Indokolás",
      "p:argumentation:Egy mondat, amelyet a parser nem ismer fel.",
    ]);
  });
});

describe("anonymisation", () => {
  test("a numbered placeholder is marked, and only the placeholder", () => {
    const [, block] = parse([
      { text: "A Kúria" },
      { text: "A felperes: név1 (cím1) képviseletében" },
    ]).documentAst.blocks;
    const inlines = block?.type === "paragraph" ? block.inlines : [];
    expect(
      inlines.map((inline) =>
        inline.type === "text"
          ? [inline.text, inline.anonymized === true]
          : [inline.type, false],
      ),
    ).toEqual([
      ["A felperes: ", false],
      ["név1", true],
      [" (", false],
      ["cím1", true],
      [") képviseletében", false],
    ]);
  });

  test("the legacy era's spelled-out placeholder is marked too", () => {
    const [, block] = parse([
      { text: "SZEGEDI ÍTÉLŐTÁBLA" },
      { text: "a felperes alperes neve (címe) ellen indított perében" },
    ]).documentAst.blocks;
    const marked =
      block?.type === "paragraph"
        ? block.inlines.flatMap((inline) =>
            inline.type === "text" && inline.anonymized === true
              ? [inline.text]
              : [],
          )
        : [];
    expect(marked).toEqual(["alperes neve"]);
  });
});

// ── End to end, one decision per era ─────────────────────

describe("a decision the publisher served", () => {
  test("the current era's DOCX reads into a sectioned AST", async () => {
    const bytes = await Bun.file(
      new URL("hu-bhgy-decision.docx", FIXTURES_DIR),
    ).arrayBuffer();
    const parsed = parseHuBhgyDecision({
      document: await parseDocx(bytes, {
        detectVariables: false,
        preloadFonts: false,
      }),
      listedCaseNumber: "Gfv.30197/2024/4",
      court: "Kúria",
      sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
      documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/",
      documentId: "eb8acbdd-45e9-467f-b6e4-8f36bbf41046",
      statutes: [],
    });

    const headings = parsed.documentAst.blocks.flatMap((block) =>
      block.type === "heading" ? [block.plainText] : [],
    );
    // The publisher left a stray keystroke in front of this one
    // ("Re     Rendelkező rész"); the section is still cut, and the heading is
    // still printed as the document prints it.
    expect(
      headings.some((heading) => heading.includes("Rendelkező rész")),
    ).toBe(true);
    expect(headings).toContain("Indokolás");
    expect(parsed.documentDocket).toBe("Gfv.VI.30.197/2024/4");
    expect(parsed.decisionType).toBe("végzés");
    expect(parsed.decisionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // Court-numbered paragraphs survive as numbers, not as text prefixes.
    const numbered = parsed.documentAst.blocks.filter(
      (block) => block.type === "paragraph" && block.number !== undefined,
    );
    expect(numbered.length).toBeGreaterThan(5);
    expect(parsed.fulltext).not.toContain("[1]");
    expect(parsed.sections.length).toBeGreaterThan(1);
    expect(parsed.readerWarnings).toEqual([]);
  });

  test("the legacy era's RTF reads into the same shape", async () => {
    const bytes = await Bun.file(
      new URL("hu-bhgy-decision.rtf", FIXTURES_DIR),
    ).bytes();
    const parsed = parseHuBhgyDecision({
      document: readRtf(bytes),
      listedCaseNumber: "Bhar.31/2009/6",
      court: "Győri Ítélőtábla",
      sourceUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
      documentUrl: "https://eakta.birosag.hu/hatarozat-letoltes/",
      documentId: "AHK4T__4567565",
      statutes: [],
    });

    expect(parsed.readerWarnings).toEqual([]);
    expect(parsed.documentDocket).toBe("Bhar.31/2009/6");
    expect(parsed.decisionDate).toBe("2009-06-30");
    // The Central-European code page decoded, so the vowels are Hungarian.
    expect(parsed.fulltext).toContain("Győri Ítélőtábla");
    // The legacy era sets its section titles letter by letter; the text keeps
    // the publisher's spacing and the heading is recognised through it.
    expect(parsed.fulltext).toContain("I n d o k o l á s :");
    expect(
      parsed.documentAst.blocks.flatMap((block) =>
        block.type === "heading" && block.level === 1 ? [block.plainText] : [],
      ),
    ).toEqual([
      "Győri Ítélőtábla, mint harmadfokú bíróság",
      "v é g z é s t :",
      "I n d o k o l á s :",
      "Záradék:",
    ]);
  });
});

test("footnotes stay with their referenced paragraphs across Hungarian sections", () => {
  const rtf = String.raw`{\rtf1 Rendelkez\u337? r\u233?sz\par Holding text{\footnote Holding note}\par Indokol\u225?s\par Reasoning text{\footnote Reasoning note one\par Reasoning note two}\par Closing text\par}`;
  const parsed = parseDocument(readRtf(new TextEncoder().encode(rtf)));
  expect(parsed.documentAst.blocks.map(({ plainText }) => plainText)).toEqual([
    "Rendelkező rész",
    "Holding text",
    "Holding note",
    "Indokolás",
    "Reasoning text",
    "Reasoning note one",
    "Reasoning note two",
    "Closing text",
  ]);
  const holding = parsed.sections.find(({ text }) =>
    text.includes("Holding text"),
  );
  const reasoning = parsed.sections.find(({ text }) =>
    text.includes("Reasoning text"),
  );
  const holdingNote = parsed.sections.find(({ text }) =>
    text.includes("Holding note"),
  );
  expect(holdingNote?.index).toBeGreaterThanOrEqual(holding?.index ?? -1);
  expect(holdingNote?.index).toBeLessThan(reasoning?.index ?? -1);
  expect(holding?.text).not.toContain("Reasoning note");
  expect(reasoning?.text).toContain("Reasoning note one");
  expect(reasoning?.text).toContain("Reasoning note two");
});

const parseHuNoteHeading = (texts: readonly string[]) =>
  parse(
    [
      { text: "Indokolás" },
      { text: "Majority text", footnotes: [1] },
      { text: "Later majority text" },
    ],
    [
      {
        type: "footnote",
        id: 1,
        content: texts.map((text) => paragraphOf({ text })),
      },
    ],
  );

test("a Hungarian note heading cannot change the following body section", () => {
  const parsed = parseHuNoteHeading(["Rendelkező rész"]);
  const note = parsed.documentAst.blocks.find(
    (block) => block.plainText === "Rendelkező rész",
  );
  expect(note?.type).toBe("paragraph");
  expect(note?.type === "paragraph" ? note.note?.type : undefined).toBe(
    "footnote",
  );
  const majority = parsed.sections.find(({ text }) =>
    text.includes("Later majority text"),
  );
  expect(majority?.text).toContain("Majority text");
  expect(majority?.text).toContain("Rendelkező rész");
  const last = parsed.documentAst.blocks.at(-1);
  expect(last?.type === "paragraph" ? last.role : undefined).toBe(
    "argumentation",
  );
});

test("heading text inserted into any HU note never changes body structure or section attribution", () => {
  const baseline = parseHuNoteHeading(["Neutral note"]);
  assertProperty(
    "heading text inserted into any HU note never changes body structure or section attribution",
    fc.property(
      fc.array(
        fc.constantFrom(
          "Rendelkező rész",
          "Indokolás",
          "Záradék:",
          "végzést:",
          "Kiadmány",
          "Győr, 2009. június 30.",
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (headings) => {
        const parsed = parseHuNoteHeading(headings);
        const body = (blocks: readonly Block[]) =>
          blocks
            .filter(
              (block) => block.type !== "paragraph" || block.note === undefined,
            )
            .map((block) => ({
              type: block.type,
              text: block.plainText,
              role: block.type === "image" ? undefined : block.role,
            }));
        expect(body(parsed.documentAst.blocks)).toEqual(
          body(baseline.documentAst.blocks),
        );
        for (const text of ["Majority text", "Later majority text"]) {
          expect(
            parsed.sections.find((section) => section.text.includes(text))
              ?.type,
          ).toBe(
            baseline.sections.find((section) => section.text.includes(text))
              ?.type,
          );
        }
        expect(parsed.decisionDate).toBe(baseline.decisionDate);
      },
    ),
    { numRuns: 100 },
  );
});

for (const path of NOTE_PATHS) {
  test.each(LINE_BOUNDARIES)(
    `typed note path ${path} with \\%s boundaries`,
    (boundary) => {
      const fixture = notePathDocument({
        parser: "hu",
        path,
        boundary,
        withNotes: true,
      });
      const baselineFixture = notePathDocument({
        parser: "hu",
        path,
        boundary,
        withNotes: false,
      });
      const parsePath = (document: FolioDocument) => {
        const parsed = parseDocument(document);
        return { blocks: parsed.documentAst.blocks, sections: parsed.sections };
      };
      assertNotePath({
        ...fixture,
        parsed: parsePath(fixture.document),
        baseline: parsePath(baselineFixture.document),
      });
    },
  );
}

const parseMatrixRtf = (source: string) => {
  const parsed = parseDocument(readRtfString(source));
  return { blocks: parsed.documentAst.blocks, sections: parsed.sections };
};
test.each(LINE_BOUNDARIES)(
  "RTF table-row note keeps membership across \\%s",
  (boundary) => {
    assertNotePath({
      parsed: parseMatrixRtf(noteTableRtf("hu", boundary, true)),
      baseline: parseMatrixRtf(noteTableRtf("hu", boundary, false)),
      anchorText: "Anchor text",
      noteHeading: "Rendelkező rész",
      nested: false,
      excluded: false,
    });
  },
);
for (const destination of ["header", "footer"] as const) {
  test.each(LINE_BOUNDARIES)(
    `RTF ${destination} notes and \\%s stay outside body extraction`,
    (boundary) => {
      const parsed = parseMatrixRtf(furnitureRtf("hu", destination, boundary));
      expect(
        parsed.blocks.map((block) => block.plainText).join(" "),
      ).not.toContain("Hidden");
      expect(
        parsed.blocks.filter(
          (block) => block.type === "paragraph" && block.note !== undefined,
        ),
      ).toEqual([]);
      expect(parsed.blocks.map((block) => block.plainText)).toEqual([
        "Indokolás",
        "Following body",
      ]);
    },
  );
}
