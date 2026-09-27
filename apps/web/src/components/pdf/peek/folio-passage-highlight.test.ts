import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SEARCH_HIT_MARK,
  TEXT_MARK_TONE_COLOR,
  textMarkClass,
} from "@stll/ui/text-mark";

const css = readFileSync(
  path.join(import.meta.dirname, "peek-docx.css"),
  "utf-8",
);

const washPercent = (classes: string, prefix: string): string =>
  new RegExp(`(?:^| )${prefix}bg-\\(--text-mark\\)/(\\d+)(?: |$)`, "u").exec(
    classes,
  )?.[1] ?? panic(`no ${prefix}wash in "${classes}"`);

/** The passage colour a selector sets, whitespace collapsed. */
const passageColor = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    return panic(`no rule for ${selector}`);
  }
  const body = css.slice(start, css.indexOf("}", start));
  return (
    /--folio-passage-highlight-color:\s*(?<value>[^;]+);/u
      .exec(body)
      ?.groups?.["value"]?.replaceAll(/\s+/gu, " ")
      .replace("( ", "(")
      .replace(" )", ")") ?? panic(`no passage colour in ${selector}`)
  );
};

// Folio's find and passage highlight is CSS the kit's classes cannot reach, so
// the stylesheet restates the search-hit fill; this keeps the two one.
describe("the document passage highlight", () => {
  test("washes in the search-hit hue as much as the fill classes do", () => {
    const classes = textMarkClass(SEARCH_HIT_MARK);
    const color = TEXT_MARK_TONE_COLOR[SEARCH_HIT_MARK.tone];

    expect(passageColor(":root .folio-passage-highlight")).toBe(
      `color-mix(in oklab, ${color} ${washPercent(classes, "")}%, transparent)`,
    );
    expect(passageColor(".dark .folio-passage-highlight")).toBe(
      `color-mix(in oklab, ${color} ${washPercent(classes, "dark:")}%, transparent)`,
    );
  });
});
