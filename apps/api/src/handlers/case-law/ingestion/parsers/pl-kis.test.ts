/**
 * The tax administration's documents, read from the HTML the EUREKA detail
 * serves. Every fixture is a captured detail with a provenance sidecar.
 */

import { describe, expect, test } from "bun:test";

import { load } from "@stll/html";
import { hasInlineChildren } from "@stll/legal-ast/document-ast";
import type { Block, Inline } from "@stll/legal-ast/document-ast";

import { parsePlKisDocumentHtml } from "@/api/handlers/case-law/ingestion/parsers/pl-kis";

const ADAPTER_FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);

/** Every captured detail, one per category the adapter ingests. */
const DETAIL_FIXTURES = [
  ...new Bun.Glob("pl-kis-detail-*.json.gz").scanSync(
    ADAPTER_FIXTURES.pathname,
  ),
]
  .toSorted()
  .map((name) => new URL(name, ADAPTER_FIXTURES));

/** DKP1.8082.1.2026, a protective opinion the export wraps at a fixed width. */
const WRAPPED = new URL("pl-kis-detail-15-opz.json.gz", ADAPTER_FIXTURES);

/** ILPB3/423-78/07-2/HS, whose questions are an ordered list. */
const NUMBERED_QUESTIONS = new URL(
  "__fixtures__/pl-kis-ilpb3-423-78-07-2-hs.json.gz",
  import.meta.url,
);

const htmlOf = async (detail: URL): Promise<string> => {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await Bun.file(detail).arrayBuffer())),
    ),
  );
  const fields =
    typeof parsed === "object" &&
    parsed !== null &&
    "dokument" in parsed &&
    typeof parsed.dokument === "object" &&
    parsed.dokument !== null &&
    "fields" in parsed.dokument &&
    Array.isArray(parsed.dokument.fields)
      ? parsed.dokument.fields
      : [];
  const html: unknown = fields.find(
    (field: unknown) =>
      typeof field === "object" &&
      field !== null &&
      "key" in field &&
      field.key === "TRESC_INTERESARIUSZ",
  )?.value;
  return typeof html === "string" ? html : "";
};

const parse = (html: string) =>
  parsePlKisDocumentHtml({
    html,
    caseNumber: "x",
    court: "x",
    decisionDate: undefined,
    decisionType: "interpretacja indywidualna",
    sourceUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentUrl: "https://eureka.mf.gov.pl/informacje/podglad/1",
    documentId: "1",
    keywords: [],
    statutes: [],
  });

/** Every text leaf of every block, table cells included. */
const textLeaves = (blocks: readonly Block[]): string[] => {
  const leaves: string[] = [];
  const walk = (inlines: readonly Inline[]): void => {
    for (const inline of inlines) {
      if (inline.type === "text") {
        leaves.push(inline.text);
      } else if (hasInlineChildren(inline)) {
        walk(inline.children);
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "table") {
      for (const cell of block.rows.flat()) {
        walk(cell.inlines);
      }
    } else if ("inlines" in block) {
      walk(block.inlines);
    }
  }
  return leaves;
};

describe("source whitespace", () => {
  test("the fixtures carry the export's line wraps inside paragraphs", async () => {
    // A wrap between two words, inside one element: what the parse must fold.
    expect(await htmlOf(WRAPPED)).toMatch(/\p{L}\n\p{L}/u);
  });

  test.each(
    DETAIL_FIXTURES.map((url) => [url.pathname.split("/").at(-1), url]),
  )(
    "%s: no line wrap, tab or run of spaces from the markup reaches the text",
    async (_name, detail) => {
      const html = await htmlOf(detail);
      if (html === "") {
        return;
      }
      const { documentAst } = parse(html);
      const leaves = textLeaves(documentAst.blocks);
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.filter((text) => /[\t\n\r\f]| {2}/u.test(text))).toEqual(
        [],
      );
    },
  );

  test("a wrapped paragraph reads as the sentence it is", async () => {
    const { fulltext } = parse(await htmlOf(WRAPPED));
    expect(fulltext).toContain(
      "W przedstawionej we wniosku planowanej czynności bierze udział 5 spółek",
    );
    expect(fulltext).toContain(
      "darowizna udziałów oraz akcji posiadanych przez OF odpowiednio w Spółce B oraz Spółce C na rzecz FR;",
    );
  });
});

describe("ordered lists", () => {
  test("a list styled to print no number gets none", async () => {
    const html = await htmlOf(
      new URL("pl-kis-detail-05-objas.json.gz", ADAPTER_FIXTURES),
    );
    const $ = load(html);
    const items = $("ol[style*='list-style-type: none'] > li")
      .toArray()
      .map((item) => $(item).text().replace(/\s+/gu, " ").trim())
      .filter((text) => text !== "");
    expect(items).not.toEqual([]);
    // A no-break space before an item's title stays in its text; compare
    // words, not the width of the gap.
    const texts = parse(html).documentAst.blocks.map((block) =>
      block.plainText.replace(/\s+/gu, " "),
    );
    for (const item of items) {
      expect(texts, item).toContain(item);
    }
  });

  test("each question keeps the number its answer cites", async () => {
    const { fulltext } = parse(await htmlOf(NUMBERED_QUESTIONS));
    const questions = [
      "1. Jaki jest katalog aktywów",
      "2. Kiedy zwrot środków",
      "3. Kiedy Spółka powinna rozpoznać przychód",
      "4. W jaki sposób rozliczyć",
      "5. Kiedy wydatki ponoszone",
    ];
    const answers = ["Ad. 1", "Ad. 2", "Ad. 3", "Ad. 4", "Ad. 5"];
    let from = 0;
    for (const question of questions) {
      const at = fulltext.indexOf(question, from);
      expect(at, question).toBeGreaterThanOrEqual(0);
      from = at;
    }
    for (const answer of answers) {
      expect(fulltext.indexOf(answer, from), answer).toBeGreaterThan(from);
    }
  });

  test.each(
    DETAIL_FIXTURES.map((url) => [url.pathname.split("/").at(-1), url]),
  )(
    "%s: an item of a plain ordered list opens with its count",
    async (_name, detail) => {
      const html = await htmlOf(detail);
      const $ = load(html);
      const items = $(
        "ol:not([type]):not([start]):not([reversed]):not([style*='list-style'])",
      )
        .toArray()
        .flatMap((list) =>
          $(list)
            .children("li:not([value])")
            .toArray()
            .map((item, index) => ({
              number: index + 1,
              text: $(item).text().replace(/\s+/gu, " ").trim(),
            })),
        )
        .filter(({ text }) => text !== "");
      const { documentAst } = parse(html);
      const texts = documentAst.blocks.map((block) =>
        block.plainText.replace(/\s+/gu, " "),
      );
      for (const { number, text } of items) {
        const opening = `${number}. ${text.slice(0, 40)}`;
        expect(
          texts.some((plainText) => plainText.startsWith(opening)),
          opening,
        ).toBe(true);
      }
    },
  );
});
