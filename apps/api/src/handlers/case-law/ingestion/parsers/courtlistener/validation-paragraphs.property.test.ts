import { expect, test } from "bun:test";
import fc from "fast-check";

import { load } from "@stll/html";
import type { Block } from "@stll/legal-ast/document-ast";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  buildValidationHtml,
  validateAst,
  validationParagraphs,
  type ValidationResult,
} from "@/api/lib/legal-search/parsers/validate-ast";
import { visibleHtmlText } from "@/api/lib/legal-search/parsers/visible-html-text";

import { courtListenerValidationPolicy } from "./validation-policy";

const word = fc.constantFrom(
  "Affirmed.",
  "the",
  "court",
  "ΛΟΓΟ[Σ]",
  "İİİ",
  "&amp;",
  "<p>",
  "\0",
  "\r\n",
  "\r",
  "\n\n",
  "\t",
  " ",
  "­",
  "[o]rganizace",
  "J u d g m e n t",
  "a b c d",
  "\ud800",
);
const paragraph = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc
    .array(fc.tuple(word, fc.constantFrom(" ", "", "\n")), { maxLength: 16 })
    .map((parts) => parts.map(([text, space]) => text + space).join("")),
);
const source = fc.array(fc.tuple(paragraph, fc.boolean()), { maxLength: 8 });

const blocksOf = (kept: readonly string[]): Block[] =>
  kept.map((text, index) => ({
    type: "paragraph",
    id: `p${index}`,
    anchorId: `p${index}`,
    inlines: [{ type: "text", text }],
    plainText: text,
  }));
// Work counters measure how the source was read, not what it holds.
const verdict = (result: ValidationResult) => ({
  ...result,
  stats: { ...result.stats, work: null },
});

test(
  "validation paragraphs hold the text of the markup built from them",
  () => {
    assertProperty(
      "validation paragraphs hold the text of the markup built from them",
      fc.property(source, (rows) => {
        const paragraphs = rows.map(([text]) => text);
        const $ = load(
          buildValidationHtml(paragraphs.map((text) => Bun.escapeHTML(text))),
        );
        expect(
          $("p")
            .toArray()
            .map((element) => visibleHtmlText($(element))),
        ).toEqual(validationParagraphs(paragraphs));
        expect(visibleHtmlText($.root())).toBe(
          validationParagraphs(paragraphs).join(""),
        );
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "validation over paragraphs matches validation over their markup",
  () => {
    assertProperty(
      "validation over paragraphs matches validation over their markup",
      fc.property(source, (rows) => {
        const paragraphs = rows.map(([text]) => text);
        const blocks = blocksOf(
          rows.flatMap(([text, kept]) => (kept ? [text] : [])),
        );
        const html = buildValidationHtml(
          paragraphs.map((text) => Bun.escapeHTML(text)),
        );
        const read = {
          type: "paragraphs",
          paragraphs: validationParagraphs(paragraphs),
        } as const;
        for (const options of [
          undefined,
          { sourcePolicy: courtListenerValidationPolicy },
        ]) {
          expect(verdict(validateAst(read, blocks, options))).toEqual(
            verdict(validateAst(html, blocks, options)),
          );
        }
      }),
    );
  },
  propertyTestTimeout(20_000),
);
