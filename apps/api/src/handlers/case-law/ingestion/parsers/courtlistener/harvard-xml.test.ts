import { describe, expect, test } from "bun:test";

import {
  type Block,
  type Inline,
  plainTextOf,
} from "@/api/handlers/case-law/document-ast";
import { opinionRow } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/test-records";
import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";

import { conservesText } from "./blocks";
import { composeCourtListenerText } from "./compose";
import { parseHarvardXml } from "./harvard-xml";
import { createTextBudget, type FormatParse, type TextUnit } from "./outcome";
import {
  recordedOpinionClusters,
  sourceWords,
  wordDifference,
} from "./test-oracle";

const parse = (text: string, rowType: OpinionType = "020lead") =>
  parseHarvardXml({
    text,
    prefix: "o1",
    rowType,
    budget: createTextBudget(),
  });

const blocksOf = (parsed: FormatParse): Block[] => {
  if (parsed.status !== "parsed") {
    throw new Error(`expected a parse, got ${parsed.status}`);
  }
  return parsed.text.units.flatMap(({ blocks }) => [...blocks]);
};

const flatten = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((node) =>
    "children" in node ? flatten(node.children) : [node],
  );

const anchorLabels = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block) =>
    "inlines" in block
      ? flatten(block.inlines).flatMap((node) =>
          node.type === "page-anchor" ? [node.label] : [],
        )
      : [],
  );

describe("Harvard XML well-formedness", () => {
  const cases = [
    ["blank", "  \n ", "blank"],
    ["an unclosed element", "<opinion><p>Affirmed.</opinion>", "malformed-xml"],
    [
      "a truncated document",
      '<opinion type="majority"><p>Judgment affirm',
      "malformed-xml",
    ],
    [
      "an HTML entity XML does not define",
      "<opinion><p>a&nbsp;b</p></opinion>",
      "malformed-xml",
    ],
    [
      "text outside the root",
      "Affirmed. <opinion><p>x</p></opinion>",
      "malformed-xml",
    ],
    [
      "a second declaration",
      '<opinion><?xml version="1.0"?><p>x</p></opinion>',
      "malformed-xml",
    ],
    [
      "an internal entity declaration",
      '<!DOCTYPE opinion [<!ENTITY e "Affirmed.">]><opinion><p>&e;</p></opinion>',
      "declared-dtd",
    ],
    [
      "an external DTD",
      '<!DOCTYPE opinion SYSTEM "file:///etc/passwd"><opinion><p>x</p></opinion>',
      "declared-dtd",
    ],
    [
      "no opinion element",
      "<casebody><p>Affirmed.</p></casebody>",
      "missing-opinion",
    ],
    [
      "a script-only body",
      "<opinion><script>alert(1)</script></opinion>",
      "no-visible-text",
    ],
    [
      "an empty opinion",
      '<opinion type="majority">\n</opinion>',
      "no-visible-text",
    ],
  ] as const;

  for (const [name, text, reason] of cases) {
    test(`refuses ${name} as ${reason}`, () => {
      expect(parse(text)).toEqual({ status: "unusable", reason });
    });
  }

  test("accepts one leading XML declaration", () => {
    const parsed = parse(
      '<?xml version="1.0" encoding="utf-8"?>\n<opinion><p>Affirmed.</p></opinion>',
    );
    expect(blocksOf(parsed).map(({ plainText }) => plainText)).toEqual([
      "Affirmed.",
    ]);
  });

  // Synthetic mutations: a figure beside text, a figure alone, and graphic
  // forms other than an image element. Each holds the opinion for its asset
  // instead of publishing the text around a picture nothing captured.
  const graphicCases = [
    [
      "an image beside text",
      '<opinion><p>See figure.</p><img src="fig.png" alt="Map"/></opinion>',
      { img: 1 },
    ],
    [
      "an image alone",
      '<opinion><p><img src="fig.png"/></p></opinion>',
      { img: 1 },
    ],
    [
      "an inline SVG diagram",
      '<opinion type="majority"><p>As shown in the controlling diagram.</p><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L20 20"/></svg></opinion>',
      { svg: 1 },
    ],
    [
      "a prefixed SVG with its own text",
      '<opinion xmlns:svg="http://www.w3.org/2000/svg"><p>Map:</p><svg:svg><svg:text>Lot 4</svg:text></svg:svg></opinion>',
      { svg: 1 },
    ],
    [
      "embedded objects and a formula",
      '<opinion><p>See <object data="a.pdf"/> and <embed src="b.png"/> where <math><mi>x</mi></math>.</p></opinion>',
      { object: 1, embed: 1, math: 1 },
    ],
  ] as const;

  for (const [name, text, graphics] of graphicCases) {
    test(`holds ${name} for its asset`, () => {
      expect(parse(text)).toEqual({ status: "requires-assets", graphics });
    });
  }
});

/** Every text run between tags, rewritten as a CDATA section. */
const asCdata = (xml: string): string =>
  xml.replace(/>([^<]+)</gu, (_, text: string) => {
    const decoded = text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
    return `><![CDATA[${decoded}]]><`;
  });

const rawTexts = (parsed: FormatParse): string[] =>
  blocksOf(parsed).map((block) =>
    "inlines" in block ? plainTextOf(block.inlines) : block.plainText,
  );

describe("Harvard XML CDATA", () => {
  test("reads CDATA at the block level as text", () => {
    expect(
      rawTexts(
        parse(
          '<opinion type="majority"><p><![CDATA[The judgment is reversed.]]></p><p>Costs awarded.</p></opinion>',
        ),
      ),
    ).toEqual(["The judgment is reversed.", "Costs awarded."]);
  });

  test("reads CDATA mixed with text and emphasis inside a paragraph", () => {
    const [block] = blocksOf(
      parse(
        "<opinion><p>The <em><![CDATA[judgment]]></em> is <![CDATA[reversed & <remanded>]]>, costs <![CDATA[to]]> appellee.</p></opinion>",
      ),
    );
    expect(
      block !== undefined && "inlines" in block ? block.inlines : null,
    ).toEqual([
      { type: "text", text: "The " },
      { type: "italic", children: [{ type: "text", text: "judgment" }] },
      { type: "text", text: " is reversed & <remanded>, costs to appellee." },
    ]);
  });

  test("a recorded opinion reads the same with every text run as CDATA", () => {
    const [opinion] = recordedOpinionClusters().get("5804213") ?? [];
    const xml = opinion?.row.xml_harvard ?? "";
    const cdata = asCdata(xml);
    expect(cdata).not.toBe(xml);
    expect(cdata).toContain("<![CDATA[");
    expect(rawTexts(parse(cdata))).toEqual(rawTexts(parse(xml)));
    expect(
      wordDifference(sourceWords("xml", cdata), sourceWords("xml", xml)),
    ).toEqual({ missing: [], extra: [] });
  });
});

describe("text conservation", () => {
  const unit = (...texts: string[]): TextUnit => ({
    kind: "opinion",
    domType: null,
    position: "row",
    boundaries: "markup",
    blocks: texts.map((plainText, index) => ({
      id: `b${index}`,
      anchorId: `p${index}`,
      type: "paragraph",
      inlines: [{ type: "text", text: plainText }],
      plainText,
    })),
  });

  test("holds when every visible character is kept in order, whatever the spacing", () => {
    expect(
      conservesText("The  judgment\n is affirmed.", [
        unit("The judgment", "is affirmed."),
      ]),
    ).toBe(true);
  });

  const mutations = [
    ["a lost word", unit("The judgment is.")],
    ["a repeated paragraph", unit("The judgment", "The judgment is affirmed.")],
    ["paragraphs out of order", unit("is affirmed.", "The judgment")],
    ["one changed character", unit("The judgment is affirmed!")],
  ] as const;

  for (const [name, parsed] of mutations) {
    test(`fails on ${name}`, () => {
      expect(conservesText("The judgment is affirmed.", [parsed])).toBe(false);
    });
  }
});

describe("Harvard XML conservation", () => {
  test("refuses a page marker holding more than its printed page", () => {
    expect(
      parse(
        '<opinion><p>See<page-number label="5">*5 the omitted clause</page-number> here.</p></opinion>',
      ),
    ).toEqual({ status: "unusable", reason: "text-not-conserved" });
  });

  test("counts only the printed page of a marker as pagination", () => {
    const parsed = parse(
      '<opinion><p>Shrin<page-number label="114">*114</page-number>ers</p></opinion>',
    );
    expect(
      parsed.status === "parsed"
        ? parsed.text.counts.paginationCharacters
        : null,
    ).toBe(4);
  });
});

describe("Harvard XML tables", () => {
  const substantial = "The court considers all evidence in the record. ".repeat(
    20,
  );

  test("keeps a caption beside its grid, in document order", () => {
    const blocks = blocksOf(
      parse(
        `<opinion type="majority"><p>${substantial}</p><table><caption>Damages are VACATED.</caption><tr><td>Affirmed.</td></tr></table></opinion>`,
      ),
    );
    expect(blocks.map(({ plainText, type }) => [type, plainText])).toEqual([
      ["paragraph", substantial.trim()],
      ["paragraph", "Damages are VACATED."],
      ["table", "Affirmed."],
    ]);
  });

  test("keeps text between rows and around the grid where it stands", () => {
    const blocks = blocksOf(
      parse(
        '<opinion><table><thead><tr><th>Count</th><th>Result</th></tr></thead>Note: counts merged.<tbody><tr><td>I</td><td>Affirmed</td></tr></tbody><tfoot><tr><td colspan="2">Total</td></tr></tfoot></table></opinion>',
      ),
    );
    expect(blocks.map(({ plainText, type }) => [type, plainText])).toEqual([
      ["table", "Count\tResult"],
      ["paragraph", "Note: counts merged."],
      ["table", "I\tAffirmed\nTotal"],
    ]);
    expect(
      blocks[0]?.type === "table" ? blocks[0].rows[0]?.[0]?.header : null,
    ).toBe(true);
    expect(
      blocks[2]?.type === "table" ? blocks[2].rows[1]?.[0]?.colSpan : null,
    ).toBe(2);
  });

  test("keeps paragraphs and nested tables in a cell apart", () => {
    const [table] = blocksOf(
      parse(
        "<opinion><table><tr><td><p>First part.</p><p>Second part.</p></td><td><table><tr><td>Inner A</td><td>Inner B</td></tr></table></td></tr></table></opinion>",
      ),
    );
    expect(
      table?.type === "table"
        ? table.rows[0]?.map(({ inlines }) => plainTextOf(inlines))
        : null,
    ).toEqual(["First part.\nSecond part.", "Inner A\nInner B"]);
  });
});

describe("Harvard XML structure", () => {
  test("groups structural opinions into units and leaves the caption outside", () => {
    // Synthetic: a combined row whose markup names a majority and a dissent.
    const parsed = parse(
      '<casebody><parties>A v. B</parties><opinion type="majority"><p>We affirm.</p></opinion><opinion type="dissent"><author>X, J.</author><p>I dissent.</p></opinion></casebody>',
      "010combined",
    );
    expect(
      parsed.status === "parsed"
        ? parsed.text.units.map(({ blocks, domType, kind }) => [
            kind,
            domType,
            blocks.map((block) => [
              block.plainText,
              block.type === "paragraph" ? block.role : block.type,
            ]),
          ])
        : null,
    ).toEqual([
      ["outside", null, [["A v. B", "parties"]]],
      ["opinion", "majority", [["We affirm.", "argumentation"]]],
      [
        "opinion",
        "dissent",
        [
          ["X, J.", "heading"],
          ["I dissent.", "dissent"],
        ],
      ],
    ]);
  });

  test("gives every paragraph of a footnote one note ID and label", () => {
    const blocks = blocksOf(
      parse(
        '<opinion type="majority"><p>Held.<footnotemark>1</footnotemark></p><footnote label="1"><p>First part.</p><p>Second part.</p></footnote><footnote label="2"><p>Other.</p></footnote></opinion>',
      ),
    );
    expect(
      blocks.map((block) =>
        block.type === "paragraph" ? (block.note ?? null) : null,
      ),
    ).toEqual([
      null,
      { type: "footnote", label: "1", noteId: "o1-fn1" },
      { type: "footnote", label: "1", noteId: "o1-fn1" },
      { type: "footnote", label: "2", noteId: "o1-fn2" },
    ]);
    expect(blocks[0]?.plainText).toBe("Held.1");
  });

  test("gives a nested opinion its own class, not the row's", () => {
    const parsed = parse(
      '<opinion type="majority"><p>Held.</p><opinion type="dissent"><p>I dissent.</p></opinion><opinion><p>Unmarked.</p></opinion></opinion>',
    );
    expect(
      parsed.status === "parsed"
        ? parsed.text.units.map(({ blocks, domType, position }) => [
            position,
            domType,
            blocks.map((block) =>
              block.type === "paragraph" ? block.role : null,
            ),
          ])
        : null,
    ).toEqual([
      ["row", "majority", ["argumentation"]],
      ["nested", "dissent", ["dissent"]],
      ["nested", null, ["unknown"]],
    ]);
  });

  test("never reads a concurrence as a dissent", () => {
    const [block] = blocksOf(
      parse(
        '<opinion type="concurrence"><p>I concur, and I would not dissent from the judgment.</p></opinion>',
        "030concurrence",
      ),
    );
    expect(block).toMatchObject({ role: "argumentation" });
  });

  test("keeps the words of an element it does not know, and counts it", () => {
    const parsed = parse(
      '<opinion type="majority"><p>Affirmed.</p><errata>Corrected text.</errata></opinion>',
    );
    expect(
      blocksOf(parsed).map((block) => [
        block.plainText,
        block.type === "paragraph" ? block.role : null,
      ]),
    ).toEqual([
      ["Affirmed.", "argumentation"],
      ["Corrected text.", "unknown"],
    ]);
    expect(
      parsed.status === "parsed" ? parsed.text.counts.unknownConstructs : null,
    ).toEqual({
      errata: 1,
    });
  });

  test("unwraps publisher citation links, so their targets cannot change the text", () => {
    const xml = (url: string, caseIds: string) =>
      `<opinion type="majority"><p>See <extracted-citation case-ids="${caseIds}" url="${url}">550 U.S. 544</extracted-citation>, 570, and <a href="${url}">Twombly</a>.</p></opinion>`;
    const original = parse(xml("https://cite.case.law/us/550/544/", "3556136"));
    const tampered = parse(xml("https://elsewhere.test/other", "1"));
    expect(blocksOf(original)).toEqual(blocksOf(tampered));
    expect(blocksOf(original)[0]?.plainText).toBe(
      "See 550 U.S. 544, 570, and Twombly.",
    );
    expect(
      blocksOf(original).every(
        (block) =>
          "inlines" in block &&
          flatten(block.inlines).every(({ type }) => type !== "link"),
      ),
    ).toBe(true);
    expect(
      original.status === "parsed" ? original.text.counts.publisherLinks : null,
    ).toBe(2);
  });

  test("never makes a page from a star in the text", () => {
    const parsed = parse(
      "<opinion><p>See 2025 WL 1852267, at *3, and id. *4.</p></opinion>",
    );
    expect(anchorLabels(blocksOf(parsed))).toEqual([]);
    expect(blocksOf(parsed)[0]?.plainText).toBe(
      "See 2025 WL 1852267, at *3, and id. *4.",
    );
  });
});

const composedRow = (clusterId: string) => {
  const opinions = recordedOpinionClusters().get(clusterId);
  if (opinions === undefined) {
    throw new Error(`no fixture for cluster ${clusterId}`);
  }
  const outcome = composeCourtListenerText(opinions);
  if (outcome.status !== "parsed") {
    throw new Error(`cluster ${clusterId} did not parse: ${outcome.status}`);
  }
  return outcome;
};

describe("Harvard XML opinions", () => {
  // Expected values below were read off the recorded XML of opinion 5659399
  // by hand: one author line, 18 paragraphs, 5 block quotations, 4 printed
  // page numbers and two footnotes, the first of two paragraphs.
  test("keeps the author line, paragraphs, quotations and notes in source order", () => {
    const { blocks, citationScopes } = composedRow("5804213");
    expect(blocks).toHaveLength(27);
    expect(blocks[0]).toMatchObject({
      type: "heading",
      role: "section-heading",
      plainText: "FILES, J.",
    });
    const roles = blocks.map((block) =>
      block.type === "paragraph" ? block.role : block.type,
    );
    expect(roles.filter((role) => role === "quote")).toHaveLength(5);
    expect(roles.filter((role) => role === "argumentation")).toHaveLength(21);
    expect(blocks[1]?.plainText).toStartWith(
      "This appeal has been taken on behalf of a charitable corporation",
    );
    // The footnote mark stays where the court printed it.
    expect(blocks[1]?.plainText).toContain("section 41,1 because");
    expect(citationScopes).toEqual([
      {
        opinionId: "cl-opinion:5659399",
        blockIds: blocks.map(({ id }) => id),
        boundaries: "proven",
      },
    ]);
  });

  test("puts a printed page break mid-word without splitting the word", () => {
    const { blocks } = composedRow("5804213");
    expect(anchorLabels(blocks)).toEqual(["114", "115", "116", "117"]);
    const shriners = blocks.find(({ plainText }) =>
      plainText.includes("to Shriners Hospitals (appellant)"),
    );
    expect(shriners).toBeDefined();
    const flat =
      shriners !== undefined && "inlines" in shriners
        ? flatten(shriners.inlines)
        : [];
    const at = flat.findIndex((node) => node.type === "page-anchor");
    const before = flat[at - 1];
    const after = flat[at + 1];
    expect(before?.type === "text" && before.text.endsWith("Shrin")).toBe(true);
    expect(
      after?.type === "text" && after.text.startsWith("ers Hospitals"),
    ).toBe(true);
  });

  test("gives every paragraph of a footnote the note's one ID and label", () => {
    const { blocks } = composedRow("5804213");
    const notes = blocks.flatMap((block) =>
      block.type === "paragraph" && block.note !== undefined
        ? [
            {
              note: block.note,
              text: block.plainText,
              anchorId: block.anchorId,
            },
          ]
        : [],
    );
    expect(notes.map(({ note }) => note.label)).toEqual(["1", "1", "2"]);
    const [first, continuation, second] = notes;
    expect(first?.note.noteId).toBe(continuation?.note.noteId);
    expect(first?.note.noteId).not.toBe(second?.note.noteId);
    expect(first?.note.noteId).toStartWith("o5659399-");
    expect(first?.text).toStartWith(
      "Probate Code, section 41: “No estate, real or personal",
    );
    expect(continuation?.text).toStartWith(
      "“Nothing herein contained is intended to",
    );
    expect(second?.text).toStartWith(
      "Appellant does not dispute that the bequest of 1,000 shares",
    );
    expect(new Set(notes.map(({ anchorId }) => anchorId)).size).toBe(3);
    // The notes close the opinion, after its last body paragraph.
    expect(
      blocks
        .slice(-3)
        .every(
          (block) => block.type === "paragraph" && block.note !== undefined,
        ),
    ).toBe(true);
  });

  // Opinion 380339 is the classed variant: star-pagination spans, a
  // footnotes division whose note repeats its mark as a backlink.
  test("reads classed page spans and footnote divisions", () => {
    const { blocks, citationScopes, opinions } = composedRow("380339");
    expect(blocks).toHaveLength(7);
    const [heading] = blocks;
    expect(heading?.type).toBe("heading");
    expect(heading?.plainText).toBe("PER CURIAM:");
    expect(
      heading !== undefined && "inlines" in heading ? heading.inlines[0] : null,
    ).toEqual({
      type: "page-anchor",
      label: "1211",
    });
    const note = blocks.at(-1);
    expect(note?.type === "paragraph" ? note.note?.label : null).toBe("1");
    // The backlink's mark became the label, so the note text starts with the
    // court's own words.
    expect(note?.plainText).toStartWith(
      ". The government asked the court to dismiss for lack of subject matter jurisdiction",
    );
    expect(blocks[1]?.plainText).toEndWith("dismiss the suit. 1");
    // A combined row whose element says `majority` has a proven boundary.
    expect(citationScopes.map(({ opinionId }) => opinionId)).toEqual([
      "cl-opinion:380339",
    ]);
    expect(opinions[0]?.coverage).toBe("opinion");
    expect(opinions[0]?.counts?.backlinkCharacters).toBe(1);
  });

  test("scopes a lead and a dissent as separate opinions in type order", () => {
    const lead = opinionRow({
      id: "20",
      type: "020lead",
      xml_harvard:
        '<opinion type="majority"><p>Certiorari denied.</p></opinion>',
    });
    const dissent = opinionRow({
      id: "10",
      type: "040dissent",
      xml_harvard:
        '<opinion type="dissent"><author>Justice White,</author><p>dissenting.</p><p>I would grant.</p></opinion>',
    });
    // Input order is dissent first; the documented order is type, then ID.
    const outcome = composeCourtListenerText([
      { row: dissent, type: "040dissent" },
      { row: lead, type: "020lead" },
    ]);
    expect(outcome.status).toBe("parsed");
    if (outcome.status !== "parsed") {
      return;
    }
    expect(outcome.citationScopes).toEqual([
      {
        opinionId: "cl-opinion:20",
        blockIds: ["o20-b1"],
        boundaries: "proven",
      },
      {
        opinionId: "cl-opinion:10",
        blockIds: ["o10-b1", "o10-b2", "o10-b3"],
        boundaries: "proven",
      },
    ]);
    expect(
      outcome.blocks.map((block) =>
        block.type === "paragraph" ? block.role : "heading",
      ),
    ).toEqual(["argumentation", "heading", "dissent", "dissent"]);
    // The separate dissent is not the principal text.
    expect(outcome.principal.body).toBe("Certiorari denied.");
  });
});

describe("Harvard XML opinions composed into scopes", () => {
  test("splits structural opinions of a combined row and leaves the caption unscoped", () => {
    // Synthetic: a combined row whose markup names a majority and a dissent.
    const row = opinionRow({
      id: "7",
      type: "010combined",
      xml_harvard:
        '<casebody><parties>A v. B</parties><opinion type="majority"><p>We affirm.</p></opinion><opinion type="dissent"><author>X, J.</author><p>I dissent.</p></opinion></casebody>',
    });
    const outcome = composeCourtListenerText([{ row, type: "010combined" }]);
    expect(outcome.status).toBe("parsed");
    if (outcome.status !== "parsed") {
      return;
    }
    expect(outcome.blocks.map(({ plainText }) => plainText)).toEqual([
      "A v. B",
      "We affirm.",
      "X, J.",
      "I dissent.",
    ]);
    expect(outcome.blocks[0]).toMatchObject({ role: "parties" });
    expect(outcome.blocks[3]).toMatchObject({ role: "dissent" });
    expect(outcome.citationScopes).toEqual([
      {
        opinionId: "cl-opinion:7",
        blockIds: ["o7-b2"],
        boundaries: "proven",
      },
      {
        opinionId: "cl-opinion:7/2",
        blockIds: ["o7-b3", "o7-b4"],
        boundaries: "proven",
      },
    ]);
    expect(outcome.principal.body).toBe("We affirm.");
  });

  test("keeps a nested opinion and the text after it in separate scopes", () => {
    const row = opinionRow({
      id: "8",
      type: "020lead",
      xml_harvard:
        '<opinion type="majority"><p>First.</p><opinion type="concurrence"><p>Concurring.</p></opinion><p>Last.</p></opinion>',
    });
    const outcome = composeCourtListenerText([{ row, type: "020lead" }]);
    expect(outcome.status === "parsed" ? outcome.citationScopes : null).toEqual(
      [
        {
          opinionId: "cl-opinion:8",
          blockIds: ["o8-b1"],
          boundaries: "proven",
        },
        {
          opinionId: "cl-opinion:8/2",
          blockIds: ["o8-b2"],
          boundaries: "proven",
        },
        {
          opinionId: "cl-opinion:8/3",
          blockIds: ["o8-b3"],
          boundaries: "proven",
        },
      ],
    );
  });

  test("leaves a body unknown where row and markup state different classes", () => {
    const row = opinionRow({
      id: "9",
      type: "020lead",
      xml_harvard: '<opinion type="dissent"><p>I dissent.</p></opinion>',
    });
    const outcome = composeCourtListenerText([{ row, type: "020lead" }]);
    expect(
      outcome.status === "parsed" ? outcome.blocks[0] : null,
    ).toMatchObject({
      role: "unknown",
    });
    expect(outcome.opinions[0]?.classConflicts).toBe(1);
  });
});
