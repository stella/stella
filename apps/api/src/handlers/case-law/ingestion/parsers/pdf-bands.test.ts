/**
 * The page bands the shared PDF reader tells by shape, on PDFs built for
 * each rule: every rule that drops a line is pinned beside the line of the
 * same text it must keep.
 */

import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  assemblePdfParagraphs,
  extractPdfBodyAndNotes,
  PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pdf-bands";

type Drawn = { text: string; x: number; y: number; size: number };

const PITCH = 16;

/** Running text from y = 600 down, one line per pitch. */
const runningText = (lines: readonly string[], top = 600): Drawn[] =>
  lines.map((text, index) => ({
    text,
    x: 72,
    y: top - index * PITCH,
    size: 12,
  }));

const BODY = [
  "Body text sets the ordinary font size of the decision for the reader.",
  "Further running text keeps the body type the most common one here.",
  "And one more line of running text in the ordinary body type follows.",
] as const;

const builtPdf = async (pages: readonly (readonly Drawn[])[]) => {
  const pdf = PDF.create();
  for (const drawn of pages) {
    const page = pdf.addPage({ size: "letter" });
    for (const { text, x, y, size } of drawn) {
      page.drawText(text, { x, y, size });
    }
  }
  return await pdf.save();
};

const read = async (pages: readonly (readonly Drawn[])[]) => {
  const { body, notes } = await extractPdfBodyAndNotes(
    await builtPdf(pages),
    PDF_PARAGRAPH_START.INDENT,
  );
  const paragraphs = assemblePdfParagraphs(body).map((runs) =>
    runs
      .map(({ text }) => text)
      .join("")
      .trim(),
  );
  return {
    paragraphs,
    text: paragraphs.join("\n"),
    notes: notes.flatMap((line) =>
      line.type === "text" && line.footnote !== undefined
        ? [line.footnote.label]
        : [],
    ),
    references: body.flatMap((line) =>
      line.type === "text"
        ? line.runs.flatMap(({ footnoteReference }) =>
            footnoteReference === undefined ? [] : [footnoteReference.label],
          )
        : [],
    ),
  };
};

const occurrences = (text: string, needle: string): number =>
  text.split(needle).length - 1;

describe("a running line in the body's own type", () => {
  const HEADER = "Ref.: OFFICE-S0001/2020/KD-12345/2020/852";
  const header: Drawn = { text: HEADER, x: 300, y: 740, size: 12 };

  test("set apart atop most pages, it goes, and the paragraph it cut reads whole", async () => {
    const { paragraphs, text } = await read([
      [
        ...runningText(BODY),
        ...runningText(["The sentence runs on to the"], 552),
      ],
      [header, ...runningText(["next page under the header.", ...BODY])],
      [header, ...runningText(BODY)],
      [header, ...runningText(BODY)],
    ]);
    expect(occurrences(text, HEADER)).toBe(0);
    expect(
      paragraphs.some((paragraph) =>
        paragraph.includes(
          "The sentence runs on to the next page under the header.",
        ),
      ),
    ).toBe(true);
  });

  test("the same sentence at the same place inside the text stays on every page", async () => {
    const repeated = "This sentence the decision repeats at the same place.";
    const page = [
      header,
      ...runningText([BODY[0], repeated, BODY[1], BODY[2]]),
    ];
    const { text } = await read([page, page, page]);
    expect(occurrences(text, repeated)).toBe(3);
    expect(occurrences(text, HEADER)).toBe(0);
  });

  test("a repeated outermost line within the text's spacing stays: a table's head row", async () => {
    const head: Drawn = {
      text: "Item Amount Date",
      x: 72,
      y: 600 + PITCH,
      size: 12,
    };
    const page = [head, ...runningText(BODY)];
    const { text } = await read([page, page, page]);
    expect(occurrences(text, "Item Amount Date")).toBe(3);
  });

  test("a line set apart atop only one page in three is no running header", async () => {
    const { text } = await read([
      runningText(BODY),
      [header, ...runningText(BODY)],
      runningText(BODY),
    ]);
    expect(occurrences(text, HEADER)).toBe(1);
  });
});

describe("the first page's letterhead footer", () => {
  const footer = (lines: readonly string[]): Drawn[] =>
    lines.map((text, index) => ({ text, x: 72, y: 70 - index * 9, size: 7 }));

  test("its block of contact lines goes, and the text above runs on to the next page", async () => {
    const { paragraphs, text } = await read([
      [
        ...runningText(BODY),
        ...runningText(["c) the third point of the list,"], 552),
        ...footer([
          "Case handled by: A. Clerk, deputy director",
          "Competition Office tel. 52 345 56 44 fax 52 345 56 17",
          "Regional branch office@example.gov www.example.gov",
          "1 Long Street, 85-034 Town",
        ]),
      ],
      runningText(["d) the fourth point of the list,", ...BODY]),
    ]);
    expect(text).not.toContain("Case handled by");
    expect(text).not.toContain("office@example.gov");
    expect(text).not.toContain("Long Street");
    const third = paragraphs.indexOf("c) the third point of the list,");
    expect(third).toBeGreaterThan(-1);
    expect(
      paragraphs.at(third + 1)?.startsWith("d) the fourth point of the list,"),
    ).toBe(true);
  });

  test("it goes with the page's own number printed below it", async () => {
    const { text } = await read([
      [
        ...runningText(BODY),
        ...footer([
          "Competition Office tel. 52 345 56 44",
          "office@example.gov www.example.gov",
        ]),
        { text: "1", x: 300, y: 30, size: 12 },
      ],
      runningText(BODY),
    ]);
    expect(text).not.toContain("office@example.gov");
  });

  test("small text set apart above the footer is the decision's and stays", async () => {
    const { text } = await read([
      [
        ...runningText(BODY),
        {
          text: "A small citation set at the foot of the text.",
          x: 72,
          y: 110,
          size: 7,
        },
        ...footer([
          "Competition Office tel. 52 345 56 44",
          "office@example.gov www.example.gov",
        ]),
      ],
      runningText(BODY),
    ]);
    expect(text).toContain("A small citation set at the foot of the text.");
    expect(text).not.toContain("office@example.gov");
  });

  test("small type at the foot without a contact line stays", async () => {
    const { text } = await read([
      [
        ...runningText(BODY),
        ...footer(["A remark set small at the foot of the first page."]),
      ],
      runningText(BODY),
    ]);
    expect(text).toContain("A remark set small at the foot of the first page.");
  });

  test("contact lines in the body's own type stay", async () => {
    const { text } = await read([
      [
        ...runningText(BODY),
        {
          text: "Write to office@example.gov for a copy.",
          x: 72,
          y: 70,
          size: 12,
        },
      ],
      runningText(BODY),
    ]);
    expect(text).toContain("Write to office@example.gov for a copy.");
  });
});

describe("a barcode", () => {
  test("its line goes where its payload is printed below it, and the payload stays", async () => {
    const { paragraphs } = await read([
      [
        { text: "*OFFICEX00ABCD*", x: 72, y: 700, size: 20 },
        { text: "OFFICEX00ABCD", x: 72, y: 684, size: 12 },
        ...runningText(BODY),
      ],
    ]);
    expect(
      paragraphs.some((paragraph) => paragraph.includes("*OFFICEX00ABCD*")),
    ).toBe(false);
    expect(
      paragraphs.some((paragraph) => paragraph.includes("OFFICEX00ABCD")),
    ).toBe(true);
  });

  test("an asterisked word without its payload below stays", async () => {
    const { text } = await read([
      [{ text: "*NOTE*", x: 72, y: 700, size: 12 }, ...runningText(BODY)],
    ]);
    expect(text).toContain("*NOTE*");
  });
});

describe("a footnote reference raised right after a number", () => {
  // Note 99 opens the page's notes from a word; `2015` then carries note 100.
  const page = (withNote: boolean): Drawn[] => [
    { text: "A claim needing a source", x: 72, y: 700, size: 12 },
    { text: "99", x: 207, y: 705, size: 7 },
    { text: "Decided in 2015", x: 72, y: 684, size: 12 },
    { text: "100", x: 156, y: 689, size: 7 },
    { text: " and since applied.", x: 168, y: 684, size: 12 },
    ...runningText(BODY),
    { text: "99", x: 72, y: 120, size: 7 },
    { text: "Source for the claim.", x: 82, y: 115, size: 9 },
    ...(withNote
      ? [
          { text: "100", x: 72, y: 105, size: 7 },
          { text: "Source for the year.", x: 86, y: 100, size: 9 },
        ]
      : []),
  ];

  test("is the reference of the note the foot opens with its number", async () => {
    const { notes, references, text } = await read([page(true)]);
    expect([...new Set(notes)]).toEqual(["99", "100"]);
    expect(references).toEqual(["99", "100"]);
    expect(text).not.toContain("Source for the year.");
  });

  test("stays the number's digits where no note has that number", async () => {
    const { references } = await read([page(false)]);
    expect(references).toEqual(["99"]);
  });
});
