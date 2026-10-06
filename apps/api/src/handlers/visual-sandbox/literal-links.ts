import { load } from "cheerio";
import { isTag } from "domhandler";
import * as v from "valibot";

import { visualLinkSchema } from "@stll/api-contract/visual-sandbox";

import type { SanitizedVisualHtml } from "./sanitize";

// Read stored source without evaluating agent scripts. Attribute values use
// HTML's decoded spelling, so a literal query separator survives serialization.
export const collectLiteralVisualLinks = (html: SanitizedVisualHtml) => {
  const links = new Set<string>();
  const collect = (source: string) => {
    for (const [candidate] of source.matchAll(/https?:\/\/[^\s"'<>`\\]+/gu)) {
      const parsed = v.safeParse(visualLinkSchema, candidate);
      if (parsed.success) {
        links.add(parsed.output);
      }
    }
  };
  collect(html);
  const $ = load(html);
  collect($("body").text());
  $("*").each((_, element) => {
    if (!isTag(element)) {
      return;
    }
    for (const value of Object.values(element.attribs)) {
      collect(value);
    }
  });
  return [...links];
};
