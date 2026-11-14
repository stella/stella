import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { DocumentAstSource } from "@stll/legal-ast/document-ast";

import { checkEuPublisherMarkup, parseEuXhtml } from "./eu-xhtml";

const source = {
  system: "eur-lex",
  documentId: "32021D0914",
  webUrl: "https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj/eng",
  printUrl: "https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj/eng/pdf",
} satisfies DocumentAstSource;

const fixture = (name: string) =>
  readFileSync(
    new URL(`__fixtures__/eu-${name}.xhtml`, import.meta.url),
    "utf-8",
  );
const parse = (html: string) => parseEuXhtml({ html, source }).unwrap();
const wrap = (content: string) => `<div class="eli-container">${content}</div>`;

const reason = (html: string) => {
  const result = parseEuXhtml({ html, source });
  expect(result.isErr()).toBe(true);
  return result.isErr() ? result.error.reason : null;
};

describe("EU publisher XHTML", () => {
  test("markup scanner handles quoted delimiters and rejects long unclosed attributes", () => {
    expect(
      checkEuPublisherMarkup(
        '<div title="a > b"><![CDATA[<x>]]><!-- <x> --><?xml version="1.0"?></div>',
      ),
    ).toBeNull();
    const malformed = `<div>${'<a title="'.repeat(4096)}</div>`;
    expect(checkEuPublisherMarkup(malformed)?.reason).toBe("malformed");
  });

  test("original articles keep publisher anchors and each numbered paragraph once", () => {
    const html = fixture("services");
    expect(html).toContain('id="001.001"');
    const result = parse(html);
    expect(result.documentAst.blocks.at(0)).toMatchObject({
      type: "heading",
      anchorId: "art_1",
    });
    expect(
      result.documentAst.blocks.some((block) => block.anchorId === "001.001"),
    ).toBe(true);
    expect(
      result.fulltext.split("This Directive establishes general provisions"),
    ).toHaveLength(2);
    expect(result.fulltext).toContain("privatisation of public entities");
    expect(
      result.documentAst.blocks.every(
        (block) => block.type !== "paragraph" || block.number === undefined,
      ),
    ).toBe(true);
    expect(parse(html)).toEqual(result);
  });

  test("consolidated numbered prose outside p elements survives with its marker", () => {
    const html = fixture("consolidation");
    expect(html).toContain('class="norm inline-element"');
    expect(html).toContain('class="grid-container grid-list"');
    const { fulltext } = parse(html);
    expect(fulltext).toContain("1. This Regulation lays down rules");
    expect(fulltext).toContain(
      "2. This Regulation protects fundamental rights",
    );
    expect(fulltext).toContain("3. The free movement of personal data");
    expect(fulltext).toContain("(a)");
    expect(fulltext).toContain(
      "in the course of an activity which falls outside",
    );
    expect(fulltext.split("This Regulation lays down rules")).toHaveLength(2);
  });

  test("a sibling annex and its table points remain after the enacting text", () => {
    const html = fixture("annex");
    expect(html.split('class="eli-container"')).toHaveLength(3);
    const { fulltext, documentAst } = parse(html);
    expect(fulltext.indexOf("Article 1")).toBeLessThan(
      fulltext.indexOf("ANNEX"),
    );
    expect(fulltext).toContain("STANDARD CONTRACTUAL CLAUSES");
    expect(fulltext).toContain("(a)");
    expect(
      fulltext.split("The purpose of these standard contractual clauses"),
    ).toHaveLength(2);
    expect(documentAst.blocks.some((block) => block.anchorId === "anx_1")).toBe(
      true,
    );
    expect(documentAst.blocks.some((block) => block.type === "table")).toBe(
      true,
    );
  });

  test("the delegated article's content is independent of its act family", () => {
    const { fulltext } = parse(fixture("delegated"));
    expect(fulltext).toContain("Article 2");
    expect(fulltext).toContain("Official Journal");
  });

  test("grid labels, unknown elements and safe links retain text without duplication", () => {
    const html = wrap(
      '<div class="grid-container grid-list"><div class="list grid-list-column-1">(b)</div><div class="grid-list-column-2"><p class="norm">Point text <span class="oj-bold">bold</span>.</p></div></div><custom>Unknown legal text</custom><p><![CDATA[Literal legal text]]></p><img alt="Publisher diagram label"/><p><a href="javascript:alert(1)">unsafe label</a> <a href="#note">note</a> <a href="https://example.eu/law">law</a></p>',
    );
    const { fulltext, documentAst } = parse(html);
    expect(fulltext).toContain("(b)");
    expect(fulltext.split("Point text")).toHaveLength(2);
    expect(fulltext).toContain("Unknown legal text");
    expect(fulltext).toContain("Literal legal text");
    expect(fulltext).toContain("Publisher diagram label");
    expect(fulltext).toContain("unsafe label");
    expect(JSON.stringify(documentAst)).not.toContain('"href":"javascript:');
    expect(JSON.stringify(documentAst)).toContain(`${source.webUrl}#note`);
    expect(JSON.stringify(documentAst)).toContain('"type":"bold"');
  });

  test("table spans and nested cell text preserve boundaries once", () => {
    const { fulltext, documentAst } = parse(
      wrap(
        '<table id="rates"><tr><th colspan="2">Rates</th></tr><tr><td rowspan="2"><p>Outer</p><table><tr><td>Inner</td></tr></table><p>After</p></td><td>20 %</td></tr></table>',
      ),
    );
    const table = documentAst.blocks.at(0);
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(table.rows.at(0)?.at(0)).toMatchObject({
        colSpan: 2,
        header: true,
      });
      expect(table.rows.at(1)?.at(0)).toMatchObject({ rowSpan: 2 });
    }
    expect(fulltext.split("Inner")).toHaveLength(2);
    expect(fulltext).toContain("Outer");
    expect(fulltext).toContain("After");
    expect(fulltext).not.toContain("OuterInner");

    const invalidSpans = parse(
      wrap(
        '<table><tr><td colspan="01">A</td><td rowspan="1001">B</td></tr></table>',
      ),
    ).documentAst.blocks.at(0);
    expect(invalidSpans?.type).toBe("table");
    if (invalidSpans?.type === "table") {
      expect(invalidSpans.rows.at(0)?.at(0)?.colSpan).toBeUndefined();
      expect(invalidSpans.rows.at(0)?.at(1)?.rowSpan).toBeUndefined();
    }
  });

  test("duplicate publisher anchors never create duplicate AST block anchors", () => {
    const { documentAst } = parse(
      wrap(
        '<div id="eu-block-2"><p>First</p><p>Second</p></div><div id="eu-block-2"><p>Quoted first</p></div>',
      ),
    );
    expect(
      new Set(documentAst.blocks.map((block) => block.anchorId)).size,
    ).toBe(documentAst.blocks.length);
  });

  test("unsupported, malformed and empty content fail explicitly", () => {
    expect(reason("<JUDGMENT><P>Formex</P></JUDGMENT>")).toBe(
      "unsupported-layout",
    );
    expect(reason("PK\u0003\u0004archive")).toBe("unsupported-layout");
    expect(reason('<div class="eli-container"><p>Truncated</div>')).toBe(
      "malformed",
    );
    expect(reason(wrap("<script>ignored</script><style>ignored</style>"))).toBe(
      "empty",
    );
  });

  test("byte, node and nesting limits refuse oversized inputs before walking them", () => {
    expect(reason(wrap("x".repeat(8 * 1024 * 1024)))).toBe("limits");
    expect(
      reason(wrap(`${"<div>".repeat(65)}text${"</div>".repeat(65)}`)),
    ).toBe("limits");
    expect(reason(wrap("<p/>".repeat(100_001)))).toBe("limits");
  });
});
