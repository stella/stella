import { describe, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { fromMarkdown } from "./fromMarkdown";
import { toMarkdown } from "./index";

const CLEAN = {
  annotations: "strip",
  trackedChanges: "clean",
  comments: "strip",
  hyperlinks: "inline",
  footnotes: "strip",
} as const;

const normalize = (src: string): string => toMarkdown(fromMarkdown(src), CLEAN);

const LOWERCASE_WORD_CHARS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;

const inlineText = fc
  .array(
    fc.array(fc.constantFrom(...LOWERCASE_WORD_CHARS), {
      minLength: 1,
      maxLength: 8,
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((words) => words.map((chars) => chars.join("")).join(" "));

const inlineMarkdown = fc.oneof(
  inlineText,
  inlineText.map((value) => `**${value}**`),
  inlineText.map((value) => `*${value}*`),
  inlineText.map((value) => `\`${value.replaceAll("`", "")}\``),
  inlineText.map(
    (value) => `[${value}](https://example.com/${encodeURIComponent(value)})`,
  ),
);

const looseListItemMarkdown = () =>
  fc
    .tuple(
      fc.array(inlineMarkdown, { minLength: 1, maxLength: 3 }),
      fc.array(inlineMarkdown, { minLength: 1, maxLength: 3 }),
    )
    .map(
      ([firstParagraph, secondParagraph]) =>
        `- ${firstParagraph.join(" ")}\n\n  ${secondParagraph.join(" ")}`,
    );

describe("markdown bridge — round-trip (properties)", () => {
  test("loose list items are idempotent after markdown bridge normalization", () => {
    fc.assert(
      fc.property(
        looseListItemMarkdown(),
        (source) => normalize(normalize(source)) === normalize(source),
      ),
      propertyConfig({ numRuns: 100 }),
    );
  });
});
