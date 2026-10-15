import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";

import {
  COURTLISTENER_HTML_FORMATS,
  COURTLISTENER_HTML_PARSERS,
  parseHeadmatter,
} from "./html";
import { createTextBudget, type FormatParse } from "./outcome";
import { selectOpinionText } from "./select";
import { parsedWords, sourceWords, wordDifference } from "./test-oracle";

const fixture = (name: string): string =>
  readFileSync(
    new URL(`__fixtures__/html/${name}.html`, import.meta.url),
    "utf-8",
  );

const sourceSpan = (source: string, snippet: string) => {
  const start = source.indexOf(snippet);
  if (start === -1 || source.includes(snippet, start + 1)) {
    throw new TypeError(`expected one source occurrence: ${snippet}`);
  }
  return { start, end: start + snippet.length };
};

const parse = (
  parser: (input: {
    text: string;
    prefix: string;
    rowType: "010combined";
    budget: ReturnType<typeof createTextBudget>;
  }) => FormatParse,
  text: string,
): Extract<FormatParse, { status: "parsed" }> => {
  const result = parser({
    text,
    prefix: "fixture",
    rowType: "010combined",
    budget: createTextBudget(),
  });
  if (result.status !== "parsed") {
    throw new TypeError(`expected parsed HTML, received ${result.status}`);
  }
  return result;
};

const flatten = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((node) =>
    "children" in node ? flatten(node.children) : [node],
  );

const pageLabels = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) =>
    "inlines" in block
      ? flatten(block.inlines).flatMap((node) =>
          node.type === "page-anchor" ? [node.label] : [],
        )
      : [],
  );

const htmlColumns = [
  {
    format: "html_with_citations",
    name: "html-with-citations-379615",
    first: "624 F.2d 1090",
    boundaries: "layout",
    exclusions: [],
  },
  {
    format: "html_lawbox",
    name: "html-lawbox-2099017",
    first: "996 A.2d 488 (2010)",
    boundaries: "layout",
    exclusions: ['<span class="star-pagination">*489</span>'],
  },
  {
    format: "html_columbia",
    name: "html-columbia-3262966",
    first:
      "Mr. A. Wyckcliff Nisbet, Jr. Attorney at Law Friday, Eldredge Clark 2000 Regions Center 400 West Capitol Little Rock, AR 72201-3493",
    boundaries: "markup",
    exclusions: ['<sup id="fn1"><a href="#ref-fn1">1</a></sup>'],
  },
  {
    format: "html_anon_2020",
    name: "html-anon-2020-4812730",
    first:
      "HERBERT and PATRICIA KEMPKER, Petitioners v. COMMISSIONER OF INTERNAL REVENUE, Respondent",
    boundaries: "markup",
    exclusions: [
      '<span class="star-pagination" number="1" pagescheme="1985 Tax Ct. Memo LEXIS 521">*521 </span>',
      '<span class="star-pagination" number="2" pagescheme="1985 Tax Ct. Memo LEXIS 521">*522 </span>',
      '<a href="#fnr_fnote1">↩</a>',
    ],
  },
  {
    format: "html",
    name: "html-383875",
    first: "634 F.2d 404",
    boundaries: "layout",
    exclusions: ['<a class="footnote" href="#fn1_ref">1</a>'],
  },
] as const;

for (const column of htmlColumns) {
  test(`reads CourtListener ${column.format} HTML`, () => {
    const text = fixture(column.name);
    const parsed = parse(COURTLISTENER_HTML_PARSERS[column.format], text);
    const blocks = parsed.text.units.flatMap(
      ({ blocks: unitBlocks }) => unitBlocks,
    );

    expect(blocks[0]?.plainText).toBe(column.first);
    expect(
      new Set(parsed.text.units.map(({ boundaries }) => boundaries)),
    ).toEqual(new Set([column.boundaries]));
    expect(
      wordDifference(
        sourceWords("html", text, {
          excludedSpans: column.exclusions.map((snippet) =>
            sourceSpan(text, snippet),
          ),
        }),
        parsedWords(blocks),
      ),
    ).toEqual({ missing: [], extra: [] });
  });
}

test("keeps CourtListener markup classes, page labels, and note boundaries", () => {
  const anon = parse(
    COURTLISTENER_HTML_PARSERS.html_anon_2020,
    fixture("html-anon-2020-4812730"),
  );
  const anonBlocks = anon.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  expect(anon.text.units.map(({ kind }) => kind)).toEqual([
    "outside",
    "opinion",
    "outside",
  ]);
  expect(anonBlocks[0]).toMatchObject({ type: "paragraph", role: "parties" });
  expect(anonBlocks[2]).toMatchObject({
    type: "paragraph",
    role: "front-matter",
  });
  expect(anon.text.counts).toMatchObject({
    pageAnchors: 2,
    notes: 1,
    paginationCharacters: 8,
    backlinkCharacters: 1,
  });
  expect(anonBlocks.at(-1)).toMatchObject({
    type: "paragraph",
    note: { type: "footnote", label: "1" },
  });

  const lawbox = parse(
    COURTLISTENER_HTML_PARSERS.html_lawbox,
    fixture("html-lawbox-2099017"),
  );
  const lawboxBlocks = lawbox.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  expect(pageLabels(lawboxBlocks)).toEqual(["489"]);
  expect(lawbox.text.counts.paginationCharacters).toBe(4);

  const columbia = parse(
    COURTLISTENER_HTML_PARSERS.html_columbia,
    fixture("html-columbia-3262966"),
  );
  const columbiaBlocks = columbia.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  expect(columbia.text.counts.notes).toBe(1);
  expect(columbia.text.counts.backlinkCharacters).toBe(1);
  expect(columbiaBlocks.at(-1)).toMatchObject({
    type: "paragraph",
    note: { type: "footnote", label: "1" },
  });
});

test("reads cluster headmatter as front matter", () => {
  const parsed = parse(parseHeadmatter, fixture("html-headmatter-2099017"));
  const blocks = parsed.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  expect(parsed.text.units.map(({ kind }) => kind)).toEqual(["outside"]);
  expect(blocks.map(({ plainText }) => plainText)).toEqual([
    "996 A.2d 488",
    "Frederick EVANS, Appellant v. COMMONWEALTH of Pennsylvania, Pennsylvania DEPARTMENT OF CORRECTIONS, Secretary Jeffrey A. Beard; Superintendent David D. Diguglielmo, State Correctional Institution at Graterford; Tom Rowlands, Records Supervisor at State Correctional Institution at Graterford; A. Scott Williamson, Deputy Superintendent, State Correctional Institution at Graterford, Appellees.",
    "Supreme Court of Pennsylvania.",
    "June 23, 2010.",
  ]);
  expect(blocks.map((block) => ("role" in block ? block.role : null))).toEqual([
    "front-matter",
    "parties",
    "front-matter",
    "front-matter",
  ]);
});

test("keeps an HTML table caption and its headed cells in order", () => {
  const text =
    "<html><body><p>Table follows.</p><table><caption>Damages are VACATED.</caption><tr><th>Year</th><th>Result</th></tr><tr><td>2024</td><td>Affirmed.</td></tr></table></body></html>";
  const parsed = parse(COURTLISTENER_HTML_PARSERS.html, text);
  const blocks = parsed.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  const table = blocks.find((block) => block.type === "table");

  expect(blocks.map(({ type }) => type)).toEqual([
    "paragraph",
    "paragraph",
    "table",
  ]);
  expect(blocks[1]?.plainText).toBe("Damages are VACATED.");
  expect(
    table?.type === "table"
      ? table.rows.map((row) =>
          row.map(({ plainText, header }) => ({ plainText, header })),
        )
      : null,
  ).toEqual([
    [
      { plainText: "Year", header: true },
      { plainText: "Result", header: true },
    ],
    [
      { plainText: "2024", header: undefined },
      { plainText: "Affirmed.", header: undefined },
    ],
  ]);
  expect(
    wordDifference(sourceWords("html", text), parsedWords(blocks)),
  ).toEqual({ missing: [], extra: [] });
});

test("keeps a table inside a real CourtListener footnote in the same note", () => {
  const parsed = parse(
    COURTLISTENER_HTML_PARSERS.html_with_citations,
    fixture("html-with-citations-4809723"),
  );
  const blocks = parsed.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  const table = blocks.find(
    (block) =>
      block.type === "table" &&
      block.plainText.includes("Less Amount Retained"),
  );

  expect(table?.type).toBe("table");
  if (table?.type !== "table") {
    throw new Error("expected the note's table");
  }
  if (table.note === undefined) {
    throw new Error("expected the table note");
  }
  expect(table.note).toEqual({
    type: "footnote",
    label: "5",
    noteId: "fixture-fn6",
  });
  const tableIndex = blocks.indexOf(table);
  const previous = blocks.at(tableIndex - 1);
  expect(
    (previous?.type === "paragraph" || previous?.type === "table") &&
      previous.note?.noteId,
  ).toBe(table.note.noteId);
});

test("keeps a table between two paragraphs in one synthetic note", () => {
  const text =
    '<div class="footnotes"><ul><li><div id="fn_1" label="1"><p>See 410 U.S. 113.</p><table><tr><td>Reporter</td><td>410 U.S. 113</td></tr></table><p>Id. at 5.</p></div></li></ul></div>';
  const parsed = parse(COURTLISTENER_HTML_PARSERS.html, text);
  const blocks = parsed.text.units.flatMap(
    ({ blocks: unitBlocks }) => unitBlocks,
  );
  const noteBlocks = blocks.filter(
    (block) =>
      (block.type === "paragraph" || block.type === "table") &&
      block.note?.noteId !== undefined,
  );

  expect(noteBlocks.map(({ type }) => type)).toEqual([
    "paragraph",
    "table",
    "paragraph",
  ]);
  expect(
    noteBlocks.map((block) =>
      block.type === "paragraph" || block.type === "table"
        ? block.note
        : undefined,
    ),
  ).toEqual([
    { type: "footnote", label: "1", noteId: "fixture-fn1" },
    { type: "footnote", label: "1", noteId: "fixture-fn1" },
    { type: "footnote", label: "1", noteId: "fixture-fn1" },
  ]);
});

for (const format of COURTLISTENER_HTML_FORMATS) {
  test(`holds a ${format} figure for its asset`, () => {
    expect(
      COURTLISTENER_HTML_PARSERS[format]({
        text: '<html><body><p>See the map.</p><img src="map.png" alt="Parcel map"></body></html>',
        prefix: "figure",
        rowType: "010combined",
        budget: createTextBudget(),
      }),
    ).toEqual({ status: "requires-assets", graphics: { img: 1 } });
  });
}

test("falls through an unusable earlier column to real HTML", () => {
  const row = opinionRow({
    xml_harvard: "",
    html_with_citations:
      "<html><body><script>window.x=1</script></body></html>",
    html_lawbox: fixture("html-lawbox-2099017"),
  });
  const selected = selectOpinionText({
    row,
    type: "010combined",
    budget: createTextBudget(),
  });

  expect(selected.status).toBe("parsed");
  if (selected.status !== "parsed") {
    return;
  }
  expect(selected.format).toBe("html_lawbox");
  expect(selected.structure).toBe("html");
  expect(
    selected.attempts.map(({ format, reason }) => ({ format, reason })),
  ).toEqual([
    { format: "xml_harvard", reason: "blank" },
    { format: "html_with_citations", reason: "no-visible-text" },
  ]);
});
