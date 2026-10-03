import { describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  readGitTree,
  sourceOwners,
} from "../../scripts/check-parser-versions.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
const RULE_NAME = "no-raw-parser-html";

const lint = async (lines: readonly string[], sourcePath = "parser.ts") =>
  await lintSingleRule(RULE_NAME, lines.join("\n"), { sourcePath });

describe.serial("HTML parser helper ownership", () => {
  test("covers every registered parser owner in the root lint scope", async () => {
    const root = new URL("../../", import.meta.url).pathname;
    const configured = await Bun.file(`${root}oxlint.config.ts`).text();
    const ruleIndex = configured.indexOf(
      '"no-raw-parser-html/no-raw-parser-html": "error"',
    );
    expect(ruleIndex).toBeGreaterThan(-1);
    const scopeStart = configured.lastIndexOf("files:", ruleIndex);
    const scope = configured.slice(scopeStart, ruleIndex);
    const files = /files:\s*\[([\s\S]*?)\]/u.exec(scope)?.at(1) ?? "";
    const excludes = /excludeFiles:\s*\[([\s\S]*?)\]/u.exec(scope)?.at(1) ?? "";
    const includeGlobs = [...files.matchAll(/"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
    const excludeGlobs = [...excludes.matchAll(/"([^"]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
    const matches = (patterns: readonly string[], file: string) =>
      patterns.some((pattern) => new Bun.Glob(pattern).match(file));

    const head = readGitTree("HEAD");
    expect(head.type).toBe("ok");
    if (head.type !== "ok") {
      return;
    }
    const census = sourceOwners(head.files);
    expect(census.errors).toEqual([]);
    expect(census.registryErrors).toEqual([]);
    expect(census.owners.size).toBeGreaterThan(0);
    const ownerModules = new Set(
      census.registeredSources.map((source) => source.module),
    );
    for (const parserPath of census.parserFiles) {
      expect(matches(includeGlobs, parserPath)).toBe(true);
      expect(matches(excludeGlobs, parserPath)).toBe(false);
    }
    const parserPaths = new Set(census.parserFiles);
    for (const pattern of includeGlobs.filter(
      (glob) => glob.includes("/adapters/") || glob.includes("/parsers/"),
    )) {
      for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
        parserPaths.add(file);
      }
    }
    expect(parserPaths.size).toBeGreaterThan(0);
    for (const parserPath of parserPaths) {
      if (matches(excludeGlobs, parserPath)) {
        continue;
      }
      expect(matches(includeGlobs, parserPath)).toBe(true);
    }

    const bannedHtml = [
      'import * as cheerio from "cheerio";',
      'const $ = cheerio.load("<table><tr><td><script>hidden</script></td></tr></table>");',
      '$("main").text();',
      '$("table").find("tr");',
      'const tag = "p"; tag !== "style";',
    ];
    for (const ownerModule of ownerModules) {
      expect(matches(includeGlobs, ownerModule)).toBe(true);
      expect(matches(excludeGlobs, ownerModule)).toBe(false);
      expect(await lint(bannedHtml, ownerModule)).toEqual([3, 4, 5]);
    }
  });

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
        'table.find("th");',
        'table.find("td, th");',
        'table.find("thead > tr > th.heading");',
        'const headers = "th"; table.find(headers);',
        '$("table th");',
        '$("table td, th");',
        'table.find("p, th, div");',
      ]),
    ).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
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
        '$("form, script").length;',
        'Bun.file("fixture.html").text(); new Response("fixture").text();',
        'const items = [{ text: () => "Visible" }]; items.find((item) => item.text());',
        'const $other = (selector: string) => selector; $other("table tr");',
        '{ const table = { text: () => "Visible" }; table.text(); }',
        '$("main").find("p, th, div");',
        'table.find("[data-kind=th], .th, #th");',
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

  test("follows XML provenance through stable state properties", async () => {
    expect(
      await lint([
        'import * as cheerio from "cheerio";',
        'const xml = cheerio.load("<record></record>", { xml: true });',
        'const html = cheerio.load("<p></p>");',
        "const state = { $: xml };",
        'const readXml = ($: cheerio.CheerioAPI) => $("record").text();',
        "readXml(state.$);",
        'const readHtml = ($: cheerio.CheerioAPI) => $("p").text();',
        "readHtml(html);",
      ]),
    ).toEqual([7]);

    const root = new URL("../../", import.meta.url).pathname;
    const plUodoPath =
      "apps/api/src/handlers/case-law/ingestion/parsers/pl-uodo.ts";
    expect(
      await lintSingleRule(
        RULE_NAME,
        await Bun.file(`${root}${plUodoPath}`).text(),
        { sourcePath: plUodoPath },
      ),
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
