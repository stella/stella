/**
 * Every character and inline element RIS can print survives into the AST
 * and its plain text, whatever order a decision prints them in.
 */
import { describe, expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import type { Inline } from "@stll/legal-ast/document-ast";
import {
  assertProperty,
  propertyConfig,
  propertySeed,
} from "@stll/property-testing";

import { parseRisDecisionXml } from "@/api/handlers/case-law/ingestion/parsers/at-ris";
import {
  normalizeInlineLayout,
  readRisContent,
  RIS_ELEMENTS,
} from "@/api/handlers/case-law/ingestion/parsers/at-ris-markup";

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

/** A text leaf, or a line break where the text is `undefined`. */
const layoutLeaf = fc
  .constantFrom("Recht", " ", "  ", "Zeit ", " Antrag", undefined)
  .map((text): Inline =>
    text === undefined ? { type: "line-break" } : { type: "text", text },
  );

/** A leaf, or a mark around any number of `inner` inlines. */
const layoutLevel = (inner: fc.Arbitrary<Inline>): fc.Arbitrary<Inline> =>
  fc.oneof(
    layoutLeaf,
    fc
      .tuple(
        fc.constantFrom("bold", "italic", "underline"),
        fc.array(inner, { maxLength: 4 }),
      )
      .map(([type, children]): Inline => ({ type, children })),
  );

/** Text and line breaks under up to three levels of marks. */
const layoutInline = layoutLevel(layoutLevel(layoutLevel(layoutLeaf)));

/** The leaves of an inline tree in reading order. */
const leavesOf = (inlines: readonly Inline[]): Inline[] =>
  inlines.flatMap((inline) =>
    "children" in inline ? leavesOf(inline.children) : [inline],
  );

describe("RIS inline layout", () => {
  test("no line break leads, trails or repeats, whatever wraps it", () => {
    assertProperty(
      "at-ris-markup-line-breaks-single",
      fc.property(fc.array(layoutInline, { maxLength: 8 }), (inlines) => {
        const leaves = leavesOf(normalizeInlineLayout(inlines));
        const breaks = leaves.flatMap((leaf, index) =>
          leaf.type === "line-break" ? [index] : [],
        );
        for (const index of breaks) {
          expect(index).toBeGreaterThan(0);
          expect(index).toBeLessThan(leaves.length - 1);
          expect(leaves.at(index + 1)?.type).not.toBe("line-break");
        }
        const text = (nodes: readonly Inline[]) =>
          nonSpace(
            nodes
              .map((leaf) => (leaf.type === "text" ? leaf.text : ""))
              .join(""),
          );
        expect(text(leaves)).toBe(text(leavesOf(inlines)));
      }),
      config(300),
    );
  });
});

const BLOCK_BODIES = [
  '<absatz ct="text">eins</absatz>',
  '<absatz ct="norm">ABGB §1</absatz>',
  "<abstand />",
  "<ueberschrift>Titel</ueberschrift>",
  '<absatz ct="begruendung">zwei <b>drei</b></absatz>',
] as const;

const readItems = (body: string) => {
  const $ = cheerio.load(`<risdok><nutzdaten>${body}</nutzdaten></risdok>`, {
    xml: true,
  });
  const content = $("nutzdaten").first().get(0);
  if (content === undefined) {
    throw new Error("markup has no nutzdaten");
  }
  return readRisContent(content);
};

describe("RIS unknown wrappers", () => {
  test("paragraphs inside unknown wrappers read as they would unwrapped", () => {
    assertProperty(
      "at-ris-markup-unknown-wrappers-transparent",
      fc.property(
        fc.array(fc.constantFrom(...BLOCK_BODIES), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.array(fc.constantFrom("neu", "zusatz", "rahmen"), {
          minLength: 1,
          maxLength: 3,
        }),
        (blocks, wrappers) => {
          const body = blocks.join("");
          const wrapped = `${wrappers.map((name) => `<${name}>`).join("")}${body}${wrappers
            .toReversed()
            .map((name) => `</${name}>`)
            .join("")}`;
          const reading = readItems(wrapped);
          expect(reading.items).toEqual(readItems(body).items);
          expect(reading.unknownElements).toEqual([...new Set(wrappers)]);
        },
      ),
      config(200),
    );
  });
});
