/**
 * Every character and inline element RIS can print survives into the AST
 * and its plain text, whatever order a decision prints them in.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Inline } from "@stll/legal-ast/document-ast";
import {
  assertProperty,
  propertyConfig,
  propertySeed,
} from "@stll/property-testing";

import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import { RIS_ELEMENTS } from "@/api/handlers/case-law/ingestion/parsers/at-ris-markup";

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

/** What a fragment prints once markup is read, as non-space characters. */
type Fragment = { xml: string; printed: string; inline: string | undefined };

const word = fc.constantFrom("Recht", "Zeit", "Revision", "Bescheid", "Antrag");

const wordFragment = word.map((text): Fragment => ({
  xml: text,
  printed: text,
  inline: undefined,
}));

/** Text that reaches the XML as an entity: the parser must decode it. */
const entityFragment = fc
  .constantFrom(
    { xml: "&amp;", printed: "&" },
    { xml: "&lt;", printed: "<" },
    { xml: "&gt;", printed: ">" },
    { xml: "&#167;", printed: "§" },
  )
  .map((entity): Fragment => ({ ...entity, inline: undefined }));

/** Every empty element that prints a character, derived from the table. */
const CHARACTER_ELEMENTS = Object.entries(RIS_ELEMENTS).flatMap(
  ([name, spec]) =>
    spec.type === "character" && spec.text.trim() !== ""
      ? [{ name, text: spec.text }]
      : [],
);

const characterFragment = fc
  .constantFrom(...CHARACTER_ELEMENTS)
  .map(({ name, text }): Fragment => ({
    xml: `<${name} />`,
    printed: text,
    inline: undefined,
  }));

const MARKS = [
  { name: "b", inline: "bold" },
  { name: "i", inline: "italic" },
  { name: "u", inline: "underline" },
  { name: "super", inline: "superscript" },
  { name: "sub", inline: "subscript" },
] as const;

const markFragment = fc
  .tuple(fc.constantFrom(...MARKS), word)
  .map(([mark, text]): Fragment => ({
    xml: `<${mark.name}>${text}</${mark.name}>`,
    printed: text,
    inline: mark.inline,
  }));

const fragments = fc.array(
  fc.oneof(wordFragment, entityFragment, characterFragment, markFragment),
  { minLength: 1, maxLength: 12 },
);

const separators = fc.constantFrom(" ", "  ", "\n");

const inlineTypes = (inlines: readonly Inline[]): string[] =>
  inlines.flatMap((inline) => [
    inline.type,
    ...("children" in inline ? inlineTypes(inline.children) : []),
  ]);

const nonSpace = (text: string): string => text.replaceAll(/[\s ]/gu, "");

describe("RIS fragments", () => {
  test("every printed character and inline element survives", () => {
    assertProperty(
      "at-ris-markup-survives",
      fc.property(fragments, separators, (parts, separator) => {
        const xml = `<risdok><nutzdaten><abschnitt><absatz ct="text">${parts
          .map(({ xml: part }) => part)
          .join(separator)}</absatz></abschnitt></nutzdaten></risdok>`;
        const parsed = parseRisDecisionXml({
          sourceDocumentId: "doc",
          caseNumber: "1",
          ecli: undefined,
          court: "court",
          decisionDate: undefined,
          decisionType: undefined,
          sourceUrl: undefined,
          xml,
        }).unwrap();

        const [block] = parsed.documentAst.blocks;
        expect(parsed.documentAst.blocks).toHaveLength(1);
        expect(parsed.unknownElements).toEqual([]);
        expect(nonSpace(block?.plainText ?? "")).toBe(
          nonSpace(parts.map(({ printed }) => printed).join("")),
        );
        const types =
          block?.type === "paragraph" ? inlineTypes(block.inlines) : [];
        for (const { inline } of parts) {
          if (inline !== undefined) {
            expect(types).toContain(inline);
          }
        }
      }),
      config(300),
    );
  });
});
