import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@/api/handlers/case-law/document-ast";
import type { OpinionType } from "@/api/handlers/case-law/ingestion/adapters/courtlistener/vocabulary";

import { parseHarvardXml } from "./harvard-xml";
import { createTextBudget, type FormatParse } from "./outcome";

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

  test("holds a body image for its asset", () => {
    expect(
      parse(
        '<opinion><p>See figure.</p><img src="fig.png" alt="Map"/></opinion>',
      ),
    ).toEqual({
      status: "requires-assets",
      images: 1,
    });
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
