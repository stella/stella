/**
 * The TST parser against texts the court served, plus the shapes the
 * recordings do not hold (text outside a paragraph, a whitespace run across
 * an inline boundary).
 */
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  BR_TST_PARAGRAPH_STYLES,
  brTstDespachoTextOf,
  parseBrTstDespacho,
  parseBrTstHtml,
  parseBrTstPrecedent,
} from "@/api/handlers/case-law/ingestion/parsers/br-tst";
import { visibleHtmlText } from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES = new URL("../adapters/__fixtures__/", import.meta.url);

const recordsOf = async (name: string): Promise<Record<string, unknown>[]> => {
  const parsed: unknown = JSON.parse(
    await Bun.file(new URL(name, FIXTURES)).text(),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed["registros"])) {
    throw new TypeError(`${name} is not a TST search response`);
  }
  return parsed["registros"].flatMap((item: unknown) =>
    isRecord(item) && isRecord(item["registro"]) ? [item["registro"]] : [],
  );
};

const identity = {
  sourceDocumentId: "ACORDAO:fixture",
  caseNumber: "0000404-14.2012.5.04.0028",
  court: "Tribunal Superior do Trabalho",
  decisionDate: undefined,
  decisionType: "acórdão",
};

const words = (text: string): string[] =>
  text
    .toLocaleLowerCase("pt")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/**
 * The source's words, paragraph by paragraph: a paragraph and a line break
 * end a word, an inline tag inside one does not.
 */
const publishedText = (html: string): string => {
  const $ = cheerio.load(html);
  $("br").replaceWith(" ");
  return $("body p")
    .toArray()
    .map((paragraph) => visibleHtmlText($(paragraph)))
    .join(" ");
};

/** Every word of the source survives into the blocks, in order. */
const expectRetained = (sourceText: string, blocks: readonly Block[]) => {
  expect(words(blocks.map((block) => block.plainText).join(" "))).toEqual(
    words(sourceText),
  );
};

const stringField = (
  record: Record<string, unknown>,
  field: string,
): string => {
  const value = record[field];
  if (typeof value !== "string") {
    throw new TypeError(`fixture has no ${field}`);
  }
  return value;
};

describe("an acórdão's full text", () => {
  test("keeps every word, in order, from a styled export", async () => {
    const [record] = await recordsOf("br-tst-acordao-2024.json");
    const html = stringField(record ?? {}, "inteiroTeorHtml");
    const parsed = parseBrTstHtml(html, identity);
    expect(Result.isOk(parsed)).toBe(true);
    if (!Result.isOk(parsed)) {
      return;
    }
    expectRetained(publishedText(html), parsed.value.documentAst.blocks);
  });

  test("reads roles and headings off the court's paragraph styles", async () => {
    const [record] = await recordsOf("br-tst-acordao-2024.json");
    const parsed = parseBrTstHtml(
      stringField(record ?? {}, "inteiroTeorHtml"),
      identity,
    );
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    const { blocks } = parsed.value.documentAst;
    const headings = blocks.filter((block) => block.type === "heading");
    expect(headings.map((block) => block.plainText)).toEqual([
      "V O T O",
      "ISTO POSTO",
    ]);
    const roles = new Set(
      blocks.flatMap((block) =>
        block.type === "paragraph" && block.role !== undefined
          ? [block.role]
          : [],
      ),
    );
    expect([...roles].toSorted()).toEqual([
      "closing",
      "intro",
      "quote",
      "signature",
    ]);
    const first = blocks.at(0);
    expect(first?.type === "paragraph" ? first.role : undefined).toBe("intro");
    // Sections are cut at the court's own headings.
    expect(
      parsed.value.sections?.flatMap(({ title }) =>
        title === null ? [] : [title],
      ),
    ).toEqual(["V O T O", "ISTO POSTO"]);
  });

  test("an export with no styles is plain paragraphs and still whole", async () => {
    const [record] = await recordsOf("br-tst-acordao-1985.json");
    const html = stringField(record ?? {}, "inteiroTeorHtml");
    const parsed = parseBrTstHtml(html, identity);
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    const { blocks } = parsed.value.documentAst;
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    expect(parsed.value.sections).toBeUndefined();
    expectRetained(publishedText(html), blocks);
  });

  test("the exporter's indentation is not text, and a gap across tags is one space", () => {
    const parsed = parseBrTstHtml(
      `<html><head><style><!-- p.default {} --></style></head><body>
        <p class=default>
          <span>   <b>RECURSO DE REVISTA. </b>
          </span><span> Conheço
            do recurso.</span>
        </p>
        loose text
        <p class=Voto><b>V O T O</b></p>
      </body></html>`,
      identity,
    );
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    expect(
      parsed.value.documentAst.blocks.map(({ type, plainText }) => [
        type,
        plainText,
      ]),
    ).toEqual([
      ["paragraph", "RECURSO DE REVISTA. Conheço do recurso."],
      ["paragraph", "loose text"],
      ["heading", "V O T O"],
    ]);
  });

  test("blocks and table cells outside a paragraph stay apart", () => {
    const parsed = parseBrTstHtml(
      "<html><body><div><div>não</div><div>conheço</div></div><table><tr><td>a</td><td>b</td></tr></table></body></html>",
      identity,
    );
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    expect(
      parsed.value.documentAst.blocks.map(({ plainText }) => plainText),
    ).toEqual(["não", "conheço", "a", "b"]);
  });

  test("names only styles it gives a role", () => {
    expect(BR_TST_PARAGRAPH_STYLES).not.toContain("Ementa");
    expect(BR_TST_PARAGRAPH_STYLES).toContain("Voto");
  });

  test("an empty export is a typed failure, not an empty document", () => {
    const parsed = parseBrTstHtml(
      "<html><body><p> </p></body></html>",
      identity,
    );
    expect(Result.isError(parsed)).toBe(true);
  });
});

describe("a despacho's text", () => {
  test("the CDATA wrapper is opened by its delimiters, not read as a comment", async () => {
    const [record] = await recordsOf("br-tst-despacho-2020.json");
    const text = stringField(record ?? {}, "txtConteudoDecisao");
    const form = brTstDespachoTextOf(text);
    expect(form.type).toBe("html");
    const parsed = parseBrTstDespacho(text, {
      ...identity,
      decisionType: "despacho",
    });
    if (!Result.isOk(parsed) || form.type !== "html") {
      throw new TypeError("the despacho did not parse");
    }
    expect(parsed.value.fulltext).toContain("D E S P A C H O");
    expect(parsed.value.fulltext).toContain("Publique-se.");
    expectRetained(publishedText(form.html), parsed.value.documentAst.blocks);
  });

  test("the plain form is one paragraph per printed line", async () => {
    const records = await recordsOf("br-tst-despacho-2024.json");
    const plain = records.find(
      (record) =>
        brTstDespachoTextOf(stringField(record, "txtConteudoDecisao")).type ===
        "text",
    );
    const text = stringField(plain ?? {}, "txtConteudoDecisao");
    const parsed = parseBrTstDespacho(text, {
      ...identity,
      decisionType: "despacho",
    });
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    const lines = text
      .split("\n")
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .filter((line) => line !== "");
    expect(
      parsed.value.documentAst.blocks.map(({ plainText }) => plainText),
    ).toEqual(lines);
  });
});

describe("a precedent", () => {
  test("prints its title, its thesis items and the court's notes on it", async () => {
    const [record] = await recordsOf("br-tst-sumula.json");
    const parsed = parseBrTstPrecedent(
      {
        titulo: stringField(record ?? {}, "titulo"),
        tese: stringField(record ?? {}, "tese"),
        observacao: stringField(record ?? {}, "observacao"),
        historico: stringField(record ?? {}, "historico"),
      },
      { ...identity, decisionType: "súmula" },
    );
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    const blocks = parsed.value.documentAst.blocks;
    expect(blocks.at(0)).toMatchObject({
      type: "heading",
      role: "decision-title",
      plainText: "PRAZO JUDICIAL.",
    });
    expect(
      blocks.filter(
        (block) => block.type === "paragraph" && block.role === "apparatus",
      ),
    ).toHaveLength(2);
  });

  test("a cancelled item keeps its text without the strike markup", () => {
    const parsed = parseBrTstPrecedent(
      {
        titulo: "EQUIPARAÇÃO SALARIAL.",
        tese: "<s>I - Item cancelado.</s> (item cancelado)\nII - Item vigente.",
        observacao: undefined,
        historico: undefined,
      },
      { ...identity, decisionType: "súmula" },
    );
    if (!Result.isOk(parsed)) {
      throw parsed.error;
    }
    expect(
      parsed.value.documentAst.blocks.map(({ plainText }) => plainText),
    ).toEqual([
      "EQUIPARAÇÃO SALARIAL.",
      "I - Item cancelado. (item cancelado)",
      "II - Item vigente.",
    ]);
  });
});
