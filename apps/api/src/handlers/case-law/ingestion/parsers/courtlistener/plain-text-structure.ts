// parser-output-unchanged: HTML loads through @stll/html, which reproduces cheerio.load output; parsed content is unchanged.
import { isTag, isText } from "domhandler";

import { load } from "@stll/html";

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
  const $ = load(text, {}, false);
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
