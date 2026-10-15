import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";

import {
  isExcludedHtmlTag,
  ownTableRows,
  visibleHtmlText,
} from "../../apps/api/src/handlers/case-law/ingestion/parsers/shared-inlines";

const $ = cheerio.load("<table><tr><td>Visible</td></tr></table>");
const table = $("table");
declare const tag: string;

// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- raw text retains invisible HTML
table.text();
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- chained raw text has the same defect
table.clone().find("p").first().text();
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html, typescript/dot-notation -- computed getter is still a raw text read
table["text"]();
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- descendant rows include nested tables
table.find("tr");
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- descendant cells include nested tables
table.find("td");
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- child selectors inside find still walk several table levels
table.find("> tbody > tr");
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- global descendant row selectors bypass row ownership
$("table tr");
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- ad hoc exclusions belong to the owner
const _isScript = tag === "script";
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- reverse style comparison bypasses the same owner
const _isStyle = tag !== "style";
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- another exclusion set can drift from the owner
const _excluded = new Set(["script", "style"]);
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- another includes list can drift from the owner
const _included = ["script", "style", "template"].includes(tag);
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- selector removal duplicates the exclusions
$("script, style").remove();
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- typed Cheerio helper reads are also guarded
const _typed = (selection: Cheerio<AnyNode>) => selection.text();
// oxlint-disable-next-line no-raw-parser-html/no-raw-parser-html -- typed API helper reads are also guarded
const _api = (document: CheerioAPI) => document("p").text();

// expect-clean: no-raw-parser-html/no-raw-parser-html
visibleHtmlText(table);
// expect-clean: no-raw-parser-html/no-raw-parser-html
ownTableRows(table);
// expect-clean: no-raw-parser-html/no-raw-parser-html
isExcludedHtmlTag(tag);
// expect-clean: no-raw-parser-html/no-raw-parser-html
table.children("td, th");
// expect-clean: no-raw-parser-html/no-raw-parser-html
table.find('[data-kind="td"]');
// expect-clean: no-raw-parser-html/no-raw-parser-html
table.attr("style");
// expect-clean: no-raw-parser-html/no-raw-parser-html
table.text("fixture text");
// expect-clean: no-raw-parser-html/no-raw-parser-html
void Bun.file("fixture.html").text();
// expect-clean: no-raw-parser-html/no-raw-parser-html
void new Response("fixture text").text();
