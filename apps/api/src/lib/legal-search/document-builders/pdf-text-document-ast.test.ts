import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  documentAstSchema,
  omitDerivablePlainText,
  parseDocumentAst,
  plainTextOf,
} from "@stll/legal-ast/document-ast";
import type {
  Block,
  DocumentAst,
  GuidanceMetadata,
  Inline,
} from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import {
  buildPdfTextDocumentAst,
  PDF_PAGE_SEPARATOR,
} from "./pdf-text-document-ast";

const METADATA = {
  type: "guidance",
  kind: "opinion",
  title: "Opinion 1/2026",
  reference: "Opinion 1/2026",
  issuedOn: null,
  issuer: {
    type: "authority",
    name: "Úřad pro ochranu osobních údajů",
    jurisdiction: "CZE",
  },
} satisfies GuidanceMetadata;

const SOURCE = {
  system: "uoou.gov.cz",
  documentId: "opinion-1-2026",
  webUrl: "https://publisher.test/opinion.pdf",
  printUrl: "",
};

const build = (text: string): DocumentAst =>
  buildPdfTextDocumentAst({
    text,
    source: SOURCE,
    metadata: METADATA,
  }).unwrap();

const marksOf = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => {
    if (inline.type === "superscript") {
      return [plainTextOf(inline.children)];
    }
    return inline.type === "text" ||
      inline.type === "line-break" ||
      inline.type === "page-anchor"
      ? []
      : marksOf(inline.children);
  });

const textWithoutMarks = (inlines: readonly Inline[]): string =>
  inlines
    .map((inline) => {
      switch (inline.type) {
        case "superscript":
        case "page-anchor":
          return "";
        case "text":
          return inline.text;
        case "line-break":
          return "\n";
        case "bold":
        case "italic":
        case "underline":
        case "subscript":
        case "link":
        case "citation":
          return textWithoutMarks(inline.children);
        default:
          inline satisfies never;
          return "";
      }
    })
    .join("");

const inlinesOf = (block: Block): Inline[] =>
  block.type === "heading" || block.type === "paragraph" ? block.inlines : [];

describe("the PDF text builder", () => {
  test("reads sections, numbered paragraphs, footnotes and their marks", () => {
    const page = (lines: string[]) => lines.join("\n");
    const ast = build(
      [
        page(["Opinion 1/2026", "Adopted on 2 January 2026", "1 | Adopted"]),
        page([
          "1  Introduction ",
          "1 The authority applies Regulation (EU) 2016/679.2 It also",
          "applies zákon č. 110/2019 Sb. in full.",
          "3",
          "This sentence carries a lone mark.",
          " ",
          "2",
          " Regulation (EU) 2016/679 of the European Parliament.",
          "3",
          " Second note,",
          "continued.",
          "2 | Adopted",
        ]),
        page([
          "1.1 Scope of the opinion",
          "2 Short paragraph.",
          "3 Another one.",
          "3 | Adopted",
        ]),
      ].join(PDF_PAGE_SEPARATOR),
    );
    expect(
      ast.blocks.map((block) => ({
        id: block.id,
        text: block.plainText,
        marks: marksOf(inlinesOf(block)),
      })),
    ).toEqual([
      {
        id: "front_1",
        text: "Opinion 1/2026 Adopted on 2 January 2026",
        marks: [],
      },
      { id: "s-1", text: "1 Introduction", marks: [] },
      {
        id: "p-1",
        text: "The authority applies Regulation (EU) 2016/679.2 It also applies zákon č. 110/2019 Sb. in full. This sentence carries a lone mark.3",
        marks: ["2", "3"],
      },
      { id: "s-1-1", text: "1.1 Scope of the opinion", marks: [] },
      { id: "p-2", text: "Short paragraph.", marks: [] },
      { id: "p-3", text: "Another one.", marks: [] },
      {
        id: "fn-2",
        text: "Regulation (EU) 2016/679 of the European Parliament.",
        marks: [],
      },
      { id: "fn-3", text: "Second note, continued.", marks: [] },
    ]);
  });

  test("never reads a section number as a footnote mark", () => {
    const ast = build(
      [
        "Contents",
        "2.2 Processing ........ 15",
        " ",
        "2",
        " A note on this page.",
      ].join("\n"),
    );
    expect(ast.blocks.map(({ plainText }) => plainText)).toContain(
      "2.2 Processing ........ 15",
    );
  });
});

/** One per section, so no two headings read alike (see `render`). */
const NAMES = ["Alpha", "Beta", "Gamma", "Delta"];

const WORDS = [
  "data",
  "processing",
  "controller",
  "notice",
  "Article",
  "rights",
];

type Paragraph = { words: string[]; marks: number };
type Section = {
  title: string[];
  paragraphs: Paragraph[];
  subsections: number;
};

const paragraph: fc.Arbitrary<Paragraph> = fc.record({
  words: fc.array(fc.constantFrom(...WORDS), { minLength: 3, maxLength: 30 }),
  marks: fc.integer({ min: 0, max: 2 }),
});

const section: fc.Arbitrary<Section> = fc.record({
  title: fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }),
  paragraphs: fc.array(paragraph, { minLength: 1, maxLength: 3 }),
  subsections: fc.integer({ min: 0, max: 2 }),
});

const layout: fc.Arbitrary<Layout> = fc.record({
  sections: fc.array(section, { minLength: 1, maxLength: 4 }),
  linesPerPage: fc.integer({ min: 4, max: 12 }),
  loneMarks: fc.boolean(),
  separator: fc.boolean(),
});

type Expected = {
  headings: string[];
  paragraphs: { number: number; text: string; marks: string[] }[];
  notes: { label: string; text: string }[];
};

const WIDTH = 60;

const wrap = (words: readonly string[]): string[] => {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + word.length + 1 > WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
};

type BodyLine = { text: string; notes: number[] };

/**
 * Lay a generated document out the way a PDF text layer prints it: wrapped
 * lines, a running footer on every page, each page's notes at its foot, and
 * each mark either glued to the word before it or on a line of its own above
 * the line it belongs to.
 */
type Layout = {
  sections: Section[];
  linesPerPage: number;
  loneMarks: boolean;
  separator: boolean;
};

const render = ({
  linesPerPage,
  loneMarks,
  sections,
  separator,
}: Layout): { text: string; expected: Expected } => {
  const expected: Expected = { headings: [], paragraphs: [], notes: [] };
  const body: BodyLine[] = [];
  let paragraphNumber = 0;
  let note = 0;
  const pushParagraph = ({ marks, words }: Paragraph): void => {
    paragraphNumber += 1;
    const sentence = [...words];
    sentence[0] = `${sentence[0]?.[0]?.toUpperCase() ?? ""}${sentence[0]?.slice(1) ?? ""}`;
    const labels: string[] = [];
    const lines = wrap(sentence).map((text): BodyLine => ({ text, notes: [] }));
    for (let index = 0; index < marks; index += 1) {
      note += 1;
      labels.push(String(note));
      expected.notes.push({ label: String(note), text: `Note ${note} text.` });
      lines.at(-1)?.notes.push(note);
    }
    const first = lines[0];
    if (first !== undefined) {
      first.text = `${paragraphNumber} ${first.text}`;
    }
    const last = lines.at(-1);
    if (last !== undefined) {
      last.text = `${last.text}.`;
    }
    body.push(...lines);
    expected.paragraphs.push({
      number: paragraphNumber,
      text: `${sentence.join(" ")}.`,
      marks: labels,
    });
  };
  for (const [
    index,
    { paragraphs, subsections, title },
  ] of sections.entries()) {
    const label = String(index + 1);
    // Real section titles differ; identical ones at every page top would be
    // indistinguishable from a running header.
    const name = NAMES[index] ?? "Other";
    const heading = `${label} ${name} ${title.join(" ")}`;
    body.push({ text: heading, notes: [] });
    expected.headings.push(label);
    for (const item of paragraphs) {
      pushParagraph(item);
    }
    for (let sub = 1; sub <= subsections; sub += 1) {
      body.push({
        text: `${label}.${sub} ${name} ${NAMES[sub] ?? "other"} detail`,
        notes: [],
      });
      expected.headings.push(`${label}.${sub}`);
      for (const item of paragraphs.slice(0, 1)) {
        pushParagraph(item);
      }
    }
  }
  const pages: string[] = [];
  // Furniture is told from text by repetition, so it needs pages to repeat on.
  const footers = Math.ceil(body.length / linesPerPage) >= 3;
  for (let start = 0; start < body.length; start += linesPerPage) {
    const lines = body.slice(start, start + linesPerPage);
    const out: string[] = [];
    const notes: number[] = [];
    for (const line of lines) {
      if (line.notes.length === 0) {
        out.push(line.text);
        continue;
      }
      notes.push(...line.notes);
      // Two marks glued together (`rights.12`) cannot be told apart, so a
      // glued mark is always alone; it sits on the full stop: `rights.3`.
      if (loneMarks || line.notes.length > 1) {
        out.push(line.notes.join(" "), line.text);
      } else {
        out.push(`${line.text}${line.notes.join("")}`);
      }
    }
    if (notes.length > 0 && separator) {
      out.push(" ");
    }
    for (const label of notes) {
      out.push(String(label), ` Note ${label}`, "text.");
    }
    if (footers) {
      out.push(`${pages.length + 1} | Adopted`);
    }
    pages.push(out.join("\n"));
  }
  return { text: pages.join(PDF_PAGE_SEPARATOR), expected };
};

describe("PDF text builder output", () => {
  test("recovers the structure a text layer prints", () => {
    assertProperty(
      "recovers the structure a text layer prints",
      fc.property(layout, (generated) => {
        const { expected, text } = render(generated);
        const ast = build(text);
        const headings = ast.blocks.flatMap((block) =>
          block.type === "heading" ? [block.id] : [],
        );
        expect(headings).toEqual(
          expected.headings.map((label) => `s-${label.replaceAll(".", "-")}`),
        );
        const paragraphs = ast.blocks.flatMap((block) =>
          block.type === "paragraph" && block.number !== undefined
            ? [
                {
                  number: block.number,
                  text: textWithoutMarks(block.inlines),
                  marks: marksOf(block.inlines),
                },
              ]
            : [],
        );
        expect(paragraphs).toEqual(expected.paragraphs);
        const notes = ast.blocks.flatMap((block) =>
          block.type === "paragraph" && block.note !== undefined
            ? [{ label: block.note.label, text: block.plainText }]
            : [],
        );
        expect(notes).toEqual(expected.notes);
      }),
    );
  });

  test("is a valid document that round-trips through the persisted reader", () => {
    assertProperty(
      "is a valid document that round-trips through the persisted reader",
      fc.property(layout, (generated) => {
        const ast = build(render(generated).text);
        expect(v.is(documentAstSchema, ast)).toBe(true);
        expect(parseDocumentAst(omitDerivablePlainText(ast))).toEqual(ast);
        expect(build(render(generated).text)).toEqual(ast);
        const ids = ast.blocks.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
    );
  });
});
