/**
 * The UOKiK decision reader against decision PDFs the register served.
 *
 * The oracle is each file's own text layer, read straight off the PDF: every
 * word it prints, less the letterhead lines named one by one, has to reach the
 * parsed document, measured by the same retention check the pipeline logs.
 * Each rule that drops a line is also pinned on a PDF built for it, with the
 * line it must not drop beside the one it must.
 */

import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import {
  extractPlPdfLetterheadContent,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import type { PlSnLine } from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import {
  parsePlUokikDocument,
  PL_UOKIK_RULING_UNREAD,
  plUokikDocumentLines,
  readPlUokikRulingHeader,
} from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import type { ParsePlUokikDocumentInput } from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import {
  buildValidationHtml,
  validateAst,
} from "@/api/lib/legal-search/parsers/validate-ast";

/** A 2011 decision whose embedded fonts name no weight. */
const DOK_9_2011 = new URL(
  "__fixtures__/pl-uokik-dok-9-2011.pdf",
  import.meta.url,
);

/** A 2024 decision with named bold faces and hanging-indent paragraphs. */
const RGD_16_2024 = new URL(
  "__fixtures__/pl-uokik-rgd-16-2024.pdf",
  import.meta.url,
);

/** A 2009 decision whose TrueType fonts name `ż` the legacy way, `zdot`. */
const RLO_15_2009 = new URL(
  "__fixtures__/pl-uokik-rlo-15-2009.pdf",
  import.meta.url,
);

/** A 2026 decision with a page-numbered footer, footnotes and a quoted statement. */
const RGD_9_2026 = new URL(
  "__fixtures__/pl-uokik-rgd-9-2026.pdf",
  import.meta.url,
);

/** A 2017 decision setting paragraphs apart by spacing, numbered at the foot. */
const DDK_2_2017 = new URL(
  "__fixtures__/pl-uokik-ddk-2-2017.pdf",
  import.meta.url,
);

/** A 2017 decision numbering its pages `Strona N z M`, indented with spaces. */
const DIH_48_2017 = new URL(
  "__fixtures__/pl-uokik-dih-48-2017.pdf",
  import.meta.url,
);

const bytesOf = async (url: URL): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(url).arrayBuffer());

const inputOf = (pdfs: Uint8Array[]): ParsePlUokikDocumentInput => ({
  pdfs,
  caseNumber: "DOK-9/2011",
  court: "Prezes Urzędu Ochrony Konkurencji i Konsumentów",
  decisionDate: "2011-11-28",
  decisionType: "decyzja",
  sourceUrl:
    "https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/1/2520D55B0F17A317C1257EC6007B9773?OpenDocument&act=Decyzja",
  documentUrl: undefined,
  documentId: "2520D55B0F17A317C1257EC6007B9773",
  keywords: [],
});

/**
 * The lines the reader drops on purpose, named one by one: the Gdańsk
 * delegation's footer, page numbers, and the numbers that open footnotes or
 * stand raised over a line (kept as a note's label and as superscripts).
 * Anything else the text layer prints has to reach the document.
 */
const DROPPED_ON_PURPOSE: readonly RegExp[] = [
  /^[\d\s]+$/u,
  /^Strona \d+ z \d+$/u,
  /^Urząd Ochrony Konkurencji i Konsumentów(?: tel\..*)?$/u,
  /^tel\.(?:\s?\+?\d|58)/u,
  /^Delegatura (?:Urzędu )?w Gdańsku/u,
  /^gdansk@uokik\.gov\.pl/u,
  /^ul\. Podwale Przedmiejskie 30/u,
  /^80-824 Gdańsk, ul\. Podwale Przedmiejskie 30/u,
];

/**
 * The text every line of the files prints, read straight off the PDF's text
 * layer rather than through the reader under test, one paragraph per line,
 * less the lines `DROPPED_ON_PURPOSE` names. A word the typesetter broke
 * across two lines ("Konku-" / "rencji") is read whole, as a reader reads it.
 */
const printedLines = async (pdfs: Uint8Array[]): Promise<string[]> => {
  const lines: string[] = [];
  for (const bytes of pdfs) {
    const pdf = await PDF.load(bytes);
    for (const page of pdf.getPages()) {
      for (const { text } of page.extractText().lines) {
        const line = text.replace(/\s+/gu, " ").trim();
        if (
          line.length > 0 &&
          !DROPPED_ON_PURPOSE.some((pattern) => pattern.test(line))
        ) {
          lines.push(line);
        }
      }
    }
  }
  return lines
    .join("\n")
    .replaceAll(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .split("\n");
};

const hasBold = (inlines: readonly Inline[]): boolean =>
  inlines.some(
    (inline) =>
      inline.type === "bold" ||
      ("children" in inline && hasBold(inline.children)),
  );

const inlinesOf = (block: Block): readonly Inline[] =>
  block.type === "paragraph" || block.type === "heading" ? block.inlines : [];

const LOSS_CODES = new Set([
  "CONTENT_LOSS",
  "MISSING_WORDS",
  "EMPTY_AST",
  "MARKUP_RESIDUE",
]);

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

describe("a UOKiK decision PDF", () => {
  test.each([
    ["a 2011 decision", DOK_9_2011],
    ["a 2024 decision", RGD_16_2024],
    ["a 2009 decision", RLO_15_2009],
    ["a 2026 decision", RGD_9_2026],
    ["a 2017 decision set apart by spacing", DDK_2_2017],
    ["a 2017 decision numbering its pages", DIH_48_2017],
  ])("%s keeps every word its text layer prints", async (_, fixture) => {
    const pdfs = [await bytesOf(fixture)];
    const parsed = await parsePlUokikDocument(inputOf(pdfs));
    expect(parsed).not.toBeNull();
    const result = validateAst(
      buildValidationHtml(await printedLines(pdfs)),
      parsed?.documentAst.blocks ?? [],
    );
    expect(result.issues.filter(({ code }) => LOSS_CODES.has(code))).toEqual(
      [],
    );
  });

  test("states the decision it is", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(DOK_9_2011)]),
    );
    expect(parsed?.fulltext).toContain("DOK-9/2011");
    expect(parsed?.fulltext).toContain("Inco-Veritas");
  });

  test("keeps the emphasis the publisher set in a bold face", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(RGD_16_2024)]),
    );
    const blocks = parsed?.documentAst.blocks ?? [];
    expect(blocks.some((block) => hasBold(inlinesOf(block)))).toBe(true);
  });

  test("opens a paragraph at a number set out with a hanging indent", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(RGD_16_2024)]),
    );
    const texts = (parsed?.documentAst.blocks ?? []).map(
      ({ plainText }) => plainText,
    );
    // The operative part's first and second points are paragraphs of their
    // own, not one run-on block.
    const first = texts.findIndex((text) => text.startsWith("I. Na podstawie"));
    const second = texts.findIndex((text) =>
      text.startsWith("II. Na podstawie"),
    );
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  test("joins several files in the order the record lists them", async () => {
    const first = await bytesOf(DOK_9_2011);
    const second = await bytesOf(RGD_16_2024);
    const joined = await parsePlUokikDocument(inputOf([first, second]));
    const text = joined?.fulltext ?? "";
    expect(occurrences(text, "Inco-Veritas")).toBeGreaterThan(0);
    expect(text.indexOf("Inco-Veritas")).toBeLessThan(
      text.indexOf("Apartamenty Senatorska"),
    );
    // No paragraph runs across the join: the last line of the first file
    // and the first line of the second never share a block.
    const blocks = joined?.documentAst.blocks ?? [];
    expect(
      blocks.some(
        ({ plainText }) =>
          plainText.includes("Inco-Veritas") &&
          plainText.includes("Apartamenty Senatorska"),
      ),
    ).toBe(false);
  });

  test("is titled as the decision it is", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(DOK_9_2011)]),
    );
    const [first] = parsed?.documentAst.blocks ?? [];
    expect(first?.type).toBe("heading");
    expect(first?.plainText).toBe("DECYZJA");
  });

  test("records the register as the document's source", async () => {
    const parsed = await parsePlUokikDocument(
      inputOf([await bytesOf(DOK_9_2011)]),
    );
    expect(parsed?.documentAst.source.system).toBe("decyzje.uokik.gov.pl");
  });

  test("no file with a text layer is no document, not an empty one", async () => {
    expect(await parsePlUokikDocument(inputOf([]))).toBeNull();
  });
});

// ── The page as the office sets it ───────────────────────

const parsedOf = async (fixture: URL) => {
  const parsed = await parsePlUokikDocument(inputOf([await bytesOf(fixture)]));
  expect(parsed).not.toBeNull();
  return {
    fulltext: parsed?.fulltext ?? "",
    blocks: parsed?.documentAst.blocks ?? [],
  };
};

const bodyOf = (blocks: readonly Block[]): Block[] =>
  blocks.filter(
    (block) => block.type !== "paragraph" || block.note === undefined,
  );

const superscriptsOf = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => {
    if (inline.type === "superscript") {
      return [
        inline.children
          .map((child) => (child.type === "text" ? child.text : ""))
          .join(""),
      ];
    }
    return "children" in inline ? superscriptsOf(inline.children) : [];
  });

/** The text a block prints before each of its superscripts, and the index. */
const raisedAfter = (inlines: readonly Inline[]): [string, string][] => {
  const out: [string, string][] = [];
  let before = "";
  const walk = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      if (node.type === "superscript") {
        out.push([before, superscriptsOf([node]).join("")]);
      } else if (node.type === "text") {
        before += node.text;
      } else if ("children" in node) {
        walk(node.children);
      }
    }
  };
  walk(inlines);
  return out;
};

describe("a UOKiK decision read as the office sets its pages", () => {
  test.each([
    ["DOK-9/2011", DOK_9_2011],
    ["RGD-16/2024", RGD_16_2024],
    ["RŁO-15/2009", RLO_15_2009],
    ["RGD-9/2026", RGD_9_2026],
    ["DDK-2/2017", DDK_2_2017],
    ["DIH-48/2017", DIH_48_2017],
  ])("%s stores no footer and no page number", async (_, fixture) => {
    const { blocks } = await parsedOf(fixture);
    const texts = blocks.map(({ plainText }) => plainText);
    expect(texts.filter((text) => /^\d{1,3}$/u.test(text))).toEqual([]);
    expect(texts.filter((text) => /Strona \d+ z \d+/u.test(text))).toEqual([]);
    expect(texts.filter((text) => text.includes("gdansk@uokik"))).toEqual([]);
  });

  test("a sentence a page break interrupts reads whole", async () => {
    const { blocks } = await parsedOf(DDK_2_2017);
    const texts = bodyOf(blocks).map(({ plainText }) => plainText);
    // The page's number used to land between `art.` and its number.
    expect(texts.filter((text) => text.endsWith("mowa w art."))).toEqual([]);
    expect(
      texts.some((text) =>
        text.includes("mowa w art. 24 ust. 2 pkt 3 ustawy z dnia 16 lutego"),
      ),
    ).toBe(true);
  });

  test("letters a font names the legacy way read as the letters they are", async () => {
    const { fulltext } = await parsedOf(RLO_15_2009);
    for (const word of [
      "jeżeli uzna",
      "karę pieniężną",
      "do budżetu państwa",
      "Skarżyska-Kamiennej",
    ]) {
      expect(fulltext).toContain(word);
    }
    for (const garbled of ["je eli", "pienię:ną", "budGetu", "SkarGyska"]) {
      expect(fulltext).not.toContain(garbled);
    }
  });

  test("an article's raised index stays on its article", async () => {
    const { blocks } = await parsedOf(RLO_15_2009);
    const raised = bodyOf(blocks).flatMap((block) =>
      raisedAfter(inlinesOf(block)),
    );
    expect(
      raised.some(
        ([before, index]) => before.endsWith("art. 479") && index === "45",
      ),
    ).toBe(true);
    // Never a paragraph of its own, nor the next line's first word.
    expect(
      bodyOf(blocks).some(({ plainText }) => plainText.startsWith("45 ")),
    ).toBe(false);
  });

  test("footnotes follow the body as notes, referenced where printed", async () => {
    const { blocks } = await parsedOf(RGD_9_2026);
    const notes = blocks.flatMap((block) =>
      block.type === "paragraph" && block.note !== undefined
        ? [{ label: block.note.label, text: block.plainText }]
        : [],
    );
    expect(notes.map(({ label }) => label)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1)),
    );
    expect(notes[0]?.text.startsWith("Patrz: https://www.finbo.pl/")).toBe(
      true,
    );
    const body = bodyOf(blocks);
    // Neither a note's text nor its reference's number opens a body paragraph.
    expect(
      body.filter(({ plainText }) => /^\d{1,2} \p{L}/u.test(plainText)),
    ).toEqual([]);
    expect(
      body
        .flatMap((block) => raisedAfter(inlinesOf(block)))
        .some(
          ([before, index]) =>
            before.endsWith("(wcześniej do 15.000 zł)") && index === "1",
        ),
    ).toBe(true);
  });

  test("an indented quoted statement is one paragraph", async () => {
    const { blocks } = await parsedOf(RGD_9_2026);
    const statement = blocks.find(({ plainText }) =>
      plainText.startsWith("„W związku z decyzją Prezesa Urzędu"),
    );
    expect(statement?.plainText).toContain(
      "decyzja była każdorazowo podejmowana przez pożyczkodawców we własnym zakresie.",
    );
  });

  test("numbered points set apart by spacing are paragraphs of their own", async () => {
    const { blocks } = await parsedOf(DDK_2_2017);
    const texts = blocks.map(({ plainText }) => plainText);
    for (const point of [
      "1. obowiązku uwzględnienia",
      "2. obowiązku zwrócenia",
      "3. obowiązku poinformowania",
    ]) {
      expect(texts.filter((text) => text.startsWith(point))).toHaveLength(1);
    }
  });

  test("a paragraph indented with typed spaces opens a paragraph", async () => {
    const { blocks } = await parsedOf(DIH_48_2017);
    expect(
      blocks.some(({ plainText }) =>
        plainText.startsWith("Po dokonanym zakupie kontrolnym"),
      ),
    ).toBe(true);
  });
});

// ── Each rule that drops a line, on a PDF built for it ───

type Drawn = { text: string; x: number; y: number; size: number };

const BODY_LINES = [
  "Body text sets the ordinary font size of the decision for the reader.",
  "Further running text keeps the body type the most common one here.",
  "And one more line of running text in the ordinary body type follows.",
];

/** A letter-size PDF of the given pages, each a body of running text plus `extra`. */
const builtPdf = async (pages: readonly (readonly Drawn[])[]) => {
  const pdf = PDF.create();
  for (const extra of pages) {
    const page = pdf.addPage({ size: "letter" });
    for (const [index, text] of BODY_LINES.entries()) {
      page.drawText(text, { x: 72, y: 600 - index * 16, size: 12 });
    }
    for (const { text, x, y, size } of extra) {
      page.drawText(text, { x, y, size });
    }
  }
  return await pdf.save();
};

const readBuilt = async (pages: readonly (readonly Drawn[])[]) => {
  const { body, notes } = await extractPlPdfLetterheadContent(
    await builtPdf(pages),
    PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
  );
  const textOf = (lines: readonly PlSnLine[]) =>
    lines.flatMap((line) =>
      line.type === "text" ? [line.runs.map(({ text }) => text).join("")] : [],
    );
  return {
    body: textOf(body),
    // Each note's lines joined, the opening line holding only its number.
    notes: [
      ...Map.groupBy(
        notes.flatMap((line) =>
          line.type === "text" && line.footnote !== undefined
            ? [{ label: line.footnote.label, line }]
            : [],
        ),
        ({ label }) => label,
      ),
    ].map(([label, lines]) => ({
      label,
      text: textOf(lines.map(({ line }) => line))
        .join(" ")
        .trim(),
    })),
    superscripts: body.flatMap((line) =>
      line.type === "text"
        ? line.runs.flatMap(({ superscript, text }) =>
            superscript === true ? [text] : [],
          )
        : [],
    ),
  };
};

describe("the lines the letterhead reading drops", () => {
  test("a footer in small type at the same place on every page goes", async () => {
    const footer = (page: number): Drawn => ({
      text: `Office of Competition, 30 Example Street, page ${String(page)}`,
      x: 150,
      y: 40,
      size: 7,
    });
    const { body } = await readBuilt([[footer(1)], [footer(2)], [footer(3)]]);
    expect(body.some((line) => line.includes("Office of Competition"))).toBe(
      false,
    );
  });

  test("body text recurring at the same place stays, whatever its numbers", async () => {
    // Two sentences differing only in a number, at the same height on two of
    // four pages: digits left out, they would read as one repeated line.
    const { body } = await readBuilt([
      [{ text: "Na podstawie art. 24 ustawy", x: 72, y: 740, size: 12 }],
      [{ text: "Na podstawie art. 25 ustawy", x: 72, y: 740, size: 12 }],
      [],
      [],
    ]);
    expect(body).toContain("Na podstawie art. 24 ustawy");
    expect(body).toContain("Na podstawie art. 25 ustawy");
  });

  test("a page's own number at its foot goes", async () => {
    const { body } = await readBuilt([
      [{ text: "1", x: 300, y: 40, size: 12 }],
      [{ text: "Strona 2 z 2", x: 430, y: 40, size: 12 }],
    ]);
    expect(body).not.toContain("1");
    expect(body).not.toContain("Strona 2 z 2");
  });

  test("a number at the left margin that equals the page's stays", async () => {
    const { body } = await readBuilt([[{ text: "1", x: 72, y: 60, size: 12 }]]);
    expect(body).toContain("1");
  });

  test("a centred cell closer to the line above than the body's line spacing stays", async () => {
    // Further from the row above than the type is tall (13pt under 12pt
    // type), nearer than the body's lines are to each other (16pt), and
    // printed nowhere a page number sits on another page.
    const { body } = await readBuilt([
      [
        { text: "Complaints received in the year", x: 72, y: 113, size: 12 },
        { text: "1", x: 300, y: 100, size: 12 },
      ],
    ]);
    expect(body).toContain("1");
  });

  test("a footnote's number at the foot is the note's label, not a page number", async () => {
    const { notes, superscripts } = await readBuilt([
      [
        { text: "A claim needing a source", x: 72, y: 700, size: 12 },
        { text: "1", x: 215, y: 705, size: 7 },
        { text: "1", x: 72, y: 105, size: 7 },
        { text: "Source for the claim.", x: 76, y: 100, size: 9 },
      ],
    ]);
    expect(notes).toEqual([{ label: "1", text: "Source for the claim." }]);
    expect(superscripts).toEqual(["1"]);
  });

  test("a reference raised inside its line is read as one", async () => {
    // The text layer keeps a span on its line within 2pt of the line's
    // baseline, so the number raised 1.9pt stays on the claim's own line.
    const { notes, superscripts } = await readBuilt([
      [
        { text: "Tekst", x: 72, y: 700, size: 12 },
        { text: "1", x: 102, y: 701.9, size: 7 },
        { text: " continues on the same line.", x: 106, y: 700, size: 12 },
        { text: "1", x: 72, y: 105, size: 7 },
        { text: "The note the claim refers to.", x: 76, y: 100, size: 9 },
      ],
    ]);
    expect(superscripts).toEqual(["1"]);
    expect(notes).toEqual([
      { label: "1", text: "The note the claim refers to." },
    ]);
  });

  test.each([
    // The type's own descent puts a small group's box 1pt higher than the
    // line's even where its baseline is barely raised.
    ["a group set barely higher", "Fine 10", "000", " PLN", 1.5],
    ["a thousands group after a number", "Fine 10", "000", " PLN", 1.9],
    ["a digit set barely higher after a word", "Tekst", "1", " follows", 1.5],
  ])(
    "%s in small type stays in its line",
    async (_, before, digits, after, raise) => {
      const { body, superscripts } = await readBuilt([
        [
          { text: before, x: 72, y: 700, size: 12 },
          { text: digits, x: 118, y: 700 + raise, size: 7 },
          { text: after, x: 130, y: 700, size: 12 },
        ],
      ]);
      expect(superscripts).toEqual([]);
      expect(
        body.some((line) => line.replace(/\s+/gu, " ").includes(digits)),
      ).toBe(true);
    },
  );

  test("an exponent over a unit makes no table row a footnote", async () => {
    const { body, notes } = await readBuilt([
      [
        { text: "A flat of 20 m", x: 72, y: 700, size: 12 },
        { text: "2", x: 150, y: 705, size: 7 },
        { text: "1", x: 72, y: 125, size: 7 },
        { text: "First row of a small table.", x: 80, y: 120, size: 9 },
        { text: "2", x: 72, y: 110, size: 7 },
        { text: "Second row of a small table.", x: 80, y: 105, size: 9 },
      ],
    ]);
    expect(notes).toEqual([]);
    expect(body.some((line) => line.includes("Second row"))).toBe(true);
  });

  /** A page with note 1 at its foot, referenced from a word. */
  const NOTE_ONE_PAGE: readonly Drawn[] = [
    { text: "A claim needing a source", x: 72, y: 700, size: 12 },
    { text: "1", x: 215, y: 705, size: 7 },
    { text: "1", x: 72, y: 105, size: 7 },
    { text: "Source for the claim.", x: 76, y: 100, size: 9 },
  ];

  test.each([
    ["an exponent over a unit", "A flat of 20 m", 150],
    ["a reference after a word", "A claim needing more", 197],
  ])(
    "%s makes no row of a numbered table the next note",
    async (_, claim, markX) => {
      // Note 1 is read on the page before, so row 2 carries the number the
      // next note would; row 1 above it in the same column shows the table.
      const { body, notes } = await readBuilt([
        NOTE_ONE_PAGE,
        [
          { text: claim, x: 72, y: 700, size: 12 },
          { text: "2", x: markX, y: 705, size: 7 },
          { text: "1", x: 72, y: 125, size: 7 },
          { text: "First row of a small table.", x: 80, y: 120, size: 9 },
          { text: "2", x: 72, y: 110, size: 7 },
          { text: "Second row of a small table.", x: 80, y: 105, size: 9 },
        ],
      ]);
      expect(notes).toEqual([{ label: "1", text: "Source for the claim." }]);
      expect(body.some((line) => line.includes("First row"))).toBe(true);
      expect(body.some((line) => line.includes("Second row"))).toBe(true);
    },
  );

  test("an exponent makes no line set unlike the notes the next note", async () => {
    // Row 2 matches the next note's number, but nothing else shows a note:
    // no note opened on its page, and its number is set larger than note 1's.
    const { body, notes } = await readBuilt([
      NOTE_ONE_PAGE,
      [
        { text: "A flat of 20 m", x: 72, y: 700, size: 12 },
        { text: "2", x: 150, y: 705, size: 7 },
        { text: "2", x: 72, y: 105, size: 9 },
        { text: "rooms and a kitchen.", x: 80, y: 105, size: 8 },
      ],
    ]);
    expect(notes).toEqual([{ label: "1", text: "Source for the claim." }]);
    expect(body.some((line) => line.includes("rooms and a kitchen"))).toBe(
      true,
    );
  });

  test("an article's index refers to the next note printed where notes are", async () => {
    // `art. 25²` after note 1: the index alone could be an article's, so the
    // note's number set in the type note 1's was is what makes it note 2.
    const { notes } = await readBuilt([
      NOTE_ONE_PAGE,
      [
        { text: "Na podstawie art. 25", x: 72, y: 700, size: 12 },
        { text: "2", x: 190, y: 705, size: 7 },
        { text: "2", x: 72, y: 105, size: 7 },
        { text: "Source for the article.", x: 76, y: 100, size: 9 },
      ],
    ]);
    expect(notes).toEqual([
      { label: "1", text: "Source for the claim." },
      { label: "2", text: "Source for the article." },
    ]);
  });
});

// ── Court rulings the register attaches ──────────────────

const RULING_FIXTURES = {
  appeal: new URL(
    "__fixtures__/pl-uokik-ruling-vi-aca-527-08.pdf",
    import.meta.url,
  ),
  supreme: new URL(
    "__fixtures__/pl-uokik-ruling-iii-sk-17-09.pdf",
    import.meta.url,
  ),
  scan: new URL(
    "__fixtures__/pl-uokik-ruling-xvii-ama-73-07.pdf",
    import.meta.url,
  ),
} as const;

const headerOf = async (fixture: URL) =>
  readPlUokikRulingHeader(await plUokikDocumentLines([await bytesOf(fixture)]));

/** Lines as a text layer states them, for headers no capture holds. */
const typeset = (lines: readonly string[]): PlSnLine[] =>
  lines.map((text) => ({
    type: "text",
    runs: [{ text, bold: false }],
    indented: false,
  }));

describe("a court ruling's header", () => {
  test("an appeal court judgment states its court, docket, date and kind", async () => {
    expect(await headerOf(RULING_FIXTURES.appeal)).toEqual({
      type: "read",
      header: {
        decisionType: "wyrok",
        // The text layer misprints the label as `Sygrs. akt`.
        caseNumber: "VI ACa 527/08",
        decisionDate: "2008-09-29",
        court: "Sąd Apelacyjny w Warszawie",
        divisionAsPrinted: "VI Wydział Cywilny",
      },
    });
  });

  test("a Supreme Court order is read through its font's letter substitution", async () => {
    expect(await headerOf(RULING_FIXTURES.supreme)).toEqual({
      type: "read",
      header: {
        decisionType: "postanowienie",
        caseNumber: "III SK 17/09",
        decisionDate: "2009-07-02",
        court: "Sąd Najwyższy",
        divisionAsPrinted: undefined,
      },
    });
  });

  test("a scan states nothing, and says so", async () => {
    expect(await headerOf(RULING_FIXTURES.scan)).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.NO_TEXT,
    });
  });

  test("an authority's decision is not a ruling", async () => {
    expect(await headerOf(DOK_9_2011)).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.KIND_NOT_READ,
    });
  });

  test("the docket and court a ruling cites below its header are never its own", () => {
    expect(
      readPlUokikRulingHeader(
        typeset([
          "WYROK W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ",
          "Dnia 29 września 2008 r.",
          "Sąd Apelacyjny w Warszawie VI Wydział Cywilny w składzie:",
          "od wyroku Sądu Okręgowego w Warszawie sygn. akt XVII AmA 73/07",
        ]),
      ),
    ).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.DOCKET_NOT_READ,
    });
    expect(
      readPlUokikRulingHeader(
        typeset([
          "Sygn. akt VI ACa 527/08",
          "WYROK",
          "Dnia 29 września 2008 r.",
          "Protokolant: sekr. sąd.",
          "na skutek apelacji od wyroku Sądu Okręgowego w Warszawie",
        ]),
      ),
    ).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.COURT_NOT_READ,
    });
  });

  test.each([
    ["a court the index does not name", "Sąd Wojskowy w Warszawie w składzie:"],
    ["no court at all", "Komisja w składzie:"],
  ])("%s is not read as a court", (_, courtLine) => {
    expect(
      readPlUokikRulingHeader(
        typeset([
          "Sygn. akt VI ACa 527/08",
          "WYROK",
          "Dnia 29 września 2008 r.",
          courtLine,
        ]),
      ),
    ).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.COURT_NOT_READ,
    });
  });

  test.each([
    ["a date that is not a day", "Dnia 31 lutego 2008 r."],
    ["a month in no calendar", "Dnia 3 brumaire 2008 r."],
  ])("%s is not a date", (_, dateLine) => {
    expect(
      readPlUokikRulingHeader(
        typeset([
          "Sygn. akt VI ACa 527/08",
          "WYROK",
          dateLine,
          "Sąd Apelacyjny w Warszawie w składzie:",
        ]),
      ),
    ).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.DATE_NOT_READ,
    });
  });

  test("a docket the grammar does not read is not a docket", () => {
    expect(
      readPlUokikRulingHeader(
        typeset([
          "Sygn. akt RKR 51/2006",
          "WYROK",
          "Dnia 29 września 2008 r.",
          "Sąd Apelacyjny w Warszawie w składzie:",
        ]),
      ),
    ).toEqual({
      type: "unread",
      reason: PL_UOKIK_RULING_UNREAD.DOCKET_NOT_READ,
    });
  });

  test("a ruling's text is kept whole, word for word", async () => {
    const pdfs = [await bytesOf(RULING_FIXTURES.appeal)];
    const parsed = await parsePlUokikDocument({
      ...inputOf(pdfs),
      caseNumber: "VI ACa 527/08",
      court: "Sąd Apelacyjny w Warszawie",
      decisionType: "wyrok",
    });
    const result = validateAst(
      buildValidationHtml(await printedLines(pdfs)),
      parsed?.documentAst.blocks ?? [],
    );
    expect(result.issues.filter(({ code }) => LOSS_CODES.has(code))).toEqual(
      [],
    );
  });
});
