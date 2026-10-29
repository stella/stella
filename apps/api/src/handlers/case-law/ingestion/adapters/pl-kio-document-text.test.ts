import { describe, expect, test } from "bun:test";

import type { Block, Inline } from "@stll/legal-ast/document-ast";

import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { assemblePlKioDecision as uncheckedAssemblePlKioDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

const assemblePlKioDecision = guardParser(uncheckedAssemblePlKioDecision);

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const gzFixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES_DIR)).arrayBuffer()),
    ),
  );

/** One ruling built from its captured document page, as the crawl builds it. */
const ruling = async (
  id: string,
  signature: string,
  documentType: string,
): Promise<IngestionResult> =>
  assemblePlKioDecision({
    item: { id, signature, issueDate: "01-01-2020", documentType },
    detailHtml: undefined,
    document: {
      type: "read",
      html: await gzFixtureText(`pl-kio-content-${id}.html.gz`),
    },
  }).decision;

const blocksOf = (decision: IngestionResult): Block[] =>
  "blocks" in decision.documentAst ? decision.documentAst.blocks : [];

const paragraphsOf = (decision: IngestionResult): string[] =>
  blocksOf(decision).flatMap((block) =>
    block.type === "paragraph" ? [block.plainText] : [],
  );

const inlinesOf = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((inline) => [
    inline,
    ...("children" in inline ? inlinesOf(inline.children) : []),
  ]);

/** Every superscript in the ruling, with the text just before it. */
const superscriptsOf = (decision: IngestionResult): string[] =>
  blocksOf(decision).flatMap((block) => {
    if (block.type !== "paragraph") {
      return [];
    }
    const flat = inlinesOf(block.inlines);
    return flat.flatMap((inline, index) => {
      if (inline.type !== "superscript") {
        return [];
      }
      const before = flat[index - 1];
      const base = before?.type === "text" ? before.text.slice(-6) : "";
      const raised = inlinesOf(inline.children)
        .map((child) => (child.type === "text" ? child.text : ""))
        .join("");
      return [`${base}^${raised}`];
    });
  });

/** Line breaks the reading kept inside paragraphs. */
const lineBreaksOf = (decision: IngestionResult): number =>
  paragraphsOf(decision).reduce(
    (count, text) => count + text.split("\n").length - 1,
    0,
  );

describe("rulings converted from the printed page", () => {
  test("a page number is no text, and a paragraph runs on across the page break", async () => {
    const decision = await ruling("100", "KIO 1367/16", "wyrok");
    const paragraphs = paragraphsOf(decision);

    expect(paragraphs.filter((text) => /^\d{1,3}$/u.test(text))).toEqual([]);
    expect(decision.fulltext).not.toMatch(/\n\d{1,3}\n/u);
    // Pages 1/2 and 3/4 of the print break inside a sentence.
    expect(decision.fulltext).toContain(
      "uiszczoną przez wykonawcę W.S. prowadzącego działalność gospodarczą",
    );
    expect(decision.fulltext).toContain("(Dz. U. z 2013 r. poz. 231).");
  });

  test("printed lines join into the paragraph they were set in", async () => {
    const decision = await ruling("3429", "KIO 399/10", "wyrok");

    // The page break of the print fell between these two words.
    expect(decision.fulltext).toContain(
      "innemu uczestnikowi postępowania, który jako jedyny nie odbierał faksu",
    );
    expect(decision.fulltext).toContain(
      "po rozpoznaniu na rozprawie w dniu 1 kwietnia 2010 r. w Warszawie odwołania wniesionego przez",
    );
    // A first line indented on the page opens its own paragraph.
    expect(
      paragraphsOf(decision).some((text) =>
        text.startsWith("W proteście, a następnie w odwołaniu"),
      ),
    ).toBe(true);
    // 160 printed line ends; a line break stays only where a line stopped short.
    expect(lineBreaksOf(decision)).toBeLessThan(20);
  });

  test("the operative part keeps each numbered point a paragraph of its own", async () => {
    const decision = await ruling("100", "KIO 1367/16", "wyrok");
    const paragraphs = paragraphsOf(decision);

    expect(
      paragraphs.some((text) => text.startsWith("2.1. zalicza w poczet")),
    ).toBe(true);
    expect(
      paragraphs.some((text) => text.startsWith("2.2. zasądza od Komendy")),
    ).toBe(true);
  });

  test("an index the converter states as a superscript stays raised", async () => {
    const decision = await ruling("17000", "KIO 834/22", "wyrok");

    expect(superscriptsOf(decision)).toContain("t. 353^1");
  });

  test("the page footer closing the document is no text", async () => {
    const decision = await ruling("17000", "KIO 834/22", "wyrok");

    expect(decision.fulltext?.trimEnd()).not.toMatch(/\n\d{1,3}$/u);
  });
});

describe("rulings converted from a Word original", () => {
  test("a numbered point is set apart from its text", async () => {
    const decision = await ruling("36118", "KIO 3485/26", "wyrok");

    expect(decision.fulltext).toContain("1. Umarza postępowanie odwoławcze");
    expect(decision.fulltext).toContain(
      "2.1 zalicza w poczet kosztów postępowania odwoławczego",
    );
    expect(decision.fulltext).not.toMatch(/(?:^|\n)\d+(?:\.\d+)*\.?\p{L}/u);
  });

  test("directional marks go, and the author's line breaks stay", async () => {
    const decision = await ruling("36575", "KIO 4418/26", "wyrok");

    expect(decision.fulltext).not.toMatch(/[\u200E\u200F\u202A-\u202E]/u);
    expect(decision.fulltext).toContain("przysługuje skarga\nza pośrednictwem");
  });
});
