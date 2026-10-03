import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
const RULE_NAME = "no-raw-parser-html";

const lint = async (lines: readonly string[], sourcePath = "parser.ts") =>
  await lintSingleRule(RULE_NAME, lines.join("\n"), { sourcePath });

describe.serial("HTML parser helper ownership", () => {
  test("rejects raw text reads through load aliases, selection aliases and typed parameters", async () => {
    expect(
      await lint([
        'import { load as read, type Cheerio as Nodes, type CheerioAPI as Document } from "cheerio";',
        'import * as html from "cheerio";',
        'const parse = read; const $ = parse("<p>Visible</p>");',
        '$("p").text();',
        'const selection = $("p"); const alias = selection;',
        'alias.clone().find("span").first().text();',
        'alias["text"]?.();',
        'const property = "text"; alias[property]();',
        "const typed = (selection: Nodes<unknown>) => selection.text();",
        'const api = (document: Document) => document("p").text();',
        "const qualified = (document: html.CheerioAPI) => document.root().text();",
        'html.load("<p>Visible</p>").text();',
      ]),
    ).toEqual([4, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("rejects descendant rows and cells across selector spellings and constant aliases", async () => {
    expect(
      await lint([
        'import { load } from "cheerio";',
        'const $ = load("<table></table>"); const table = $("table");',
        'table.find("tr");',
        'table.find("td");',
        'table.find("> tbody > tr");',
        'table.find("tbody tr.row, tfoot > tr");',
        "table.find(`td.content`);",
        'const rows = "tr"; table.find(rows);',
        '$("table > tbody > tr");',
        '$("table td");',
        'table.find("p, td, div");',
      ]),
    ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test("rejects comparisons, switch cases, sets, includes lists and exclusion selectors", async () => {
    expect(
      await lint([
        'import { load } from "cheerio";',
        'const $ = load("<p></p>"); const tag = "p";',
        'const script = "script"; const same = tag === script;',
        'const other = "style" !== tag;',
        'switch (tag) { case "script": break; case "style": break; }',
        'const ignored = new Set(["script", "style"]);',
        'const excluded = ["script", "style"].includes(tag);',
        '$("script, style").remove();',
        '$("p").find("script, .tooltip").remove();',
      ]),
    ).toEqual([3, 4, 5, 5, 6, 7, 8, 9]);
  });

  test("accepts helper calls, direct cells, text setters, unrelated methods and selector attributes", async () => {
    expect(
      await lint([
        'import * as cheerio from "cheerio";',
        'const $ = cheerio.load("<table></table>"); const table = $("table");',
        'visibleHtmlText(table); ownTableRows(table); isExcludedHtmlTag("p");',
        'table.children("td, th");',
        'table.find("[data-kind=td], [data-tag=script], .tr");',
        '$("main").find("p, td, div");',
        'table.attr("style"); table.text("fixture text");',
        'Bun.file("fixture.html").text(); new Response("fixture").text();',
        'const items = [{ text: () => "Visible" }]; items.find((item) => item.text());',
        'const $other = (selector: string) => selector; $other("table tr");',
        '{ const table = { text: () => "Visible" }; table.text(); }',
      ]),
    ).toEqual([]);
  });

  test("reserves the raw operations to the exact shared helper owner", async () => {
    const source = [
      'import { load } from "cheerio";',
      'const $ = load("<p></p>");',
      '$("p").text();',
    ];
    expect(
      await lint(
        source,
        "apps/api/src/handlers/case-law/ingestion/parsers/shared-inlines.ts",
      ),
    ).toEqual([]);
    expect(await lint(source, "other/shared-inlines.ts")).toEqual([3]);
  });

  test("keeps quoted attribute brackets and escaped quotes outside tag detection", async () => {
    const selectors = [
      '[data-note="] td script"]',
      "[data-note='x\\' ] td script']",
      ':contains("td script")',
      '[data-note="] td script"] tr',
      "[data-note='x\\' ] td script'] > td",
      `${"[".repeat(20_000)}td script`,
    ];
    expect(
      await lint([
        'import { load } from "cheerio";',
        'const $ = load("<table></table>"); const table = $("table");',
        ...selectors.map(
          (selector) => `table.find(${JSON.stringify(selector)});`,
        ),
      ]),
    ).toEqual([6, 7]);
  });

  test("preserves XML text semantics while guarding HTML in a mixed parser", async () => {
    expect(
      await lint([
        'import * as cheerio from "cheerio";',
        'const xml = cheerio.load("<record></record>", { xml: true });',
        'const html = cheerio.load("<p></p>");',
        'xml("record").text(); xml("record").find("td").text();',
        'html("p").text();',
        'const metadata = ($: cheerio.CheerioAPI) => $("record").text();',
        "metadata(xml);",
        'const content = ($: cheerio.CheerioAPI) => $("p").text();',
        "content(html);",
      ]),
    ).toEqual([5, 8]);
    expect(
      await lint([
        'import { load } from "cheerio";',
        'const options = { xmlMode: true }; const $ = load("<record></record>", options);',
        '$("record").text(); $("table tr");',
        'const tags = new Set(["script", "style"]);',
      ]),
    ).toEqual([]);
  });

  test("guards HTML helper modules and local Cheerio type aliases without a load call", async () => {
    expect(
      await lint([
        'import * as cheerio from "cheerio";',
        'import { visibleHtmlText } from "./shared-inlines";',
        "type Root = cheerio.CheerioAPI;",
        "type Nodes = cheerio.Cheerio<unknown>;",
        'const helper = ($: Root) => $("p").text();',
        "const selection = (nodes: Nodes) => nodes.text();",
        'const correct = ($: Root) => visibleHtmlText($("p"));',
      ]),
    ).toEqual([5, 6]);
  });
});
