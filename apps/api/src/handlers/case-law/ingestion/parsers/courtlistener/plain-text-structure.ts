import * as cheerio from "cheerio";
import { isTag, isText } from "domhandler";

const STRUCTURAL_TAGS = new Set([
  "div",
  "article",
  "section",
  "main",
  "body",
  "html",
  "pre",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
]);

/** Prose outside structural roots keeps the plain column's literal markup. */
export const plainTextStructureOf = (text: string): "plain" | "html" => {
  const $ = cheerio.load(text, {}, false);
  let hasStructuralRoot = false;
  for (const node of $.root().contents().toArray()) {
    if (isText(node)) {
      if (node.data.trim() !== "") {
        return "plain";
      }
      continue;
    }
    if (!isTag(node)) {
      continue;
    }
    if (!STRUCTURAL_TAGS.has(node.name.toLowerCase())) {
      return "plain";
    }
    hasStructuralRoot = true;
  }
  return hasStructuralRoot ? "html" : "plain";
};
