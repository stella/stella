import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ElementContent, Root, RootContent } from "hast";

import { assertProperty } from "@stll/property-testing";

import { rehypeLegalCitationLinks } from "@/components/chat/rehype-legal-citation-links";

const ZP_URL = "https://app.example/law/cze/statutes/zakonik-prace#par_52";
const NS_URL = "https://app.example/law/cze/cases/ns/21-cdo-4733-2015";

const textContent = (
  nodes: readonly (ElementContent | RootContent)[],
): string =>
  nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }
      return node.type === "element" ? textContent(node.children) : "";
    })
    .join("");

const paragraph = (...children: ElementContent[]): Root => ({
  type: "root",
  children: [{ type: "element", tagName: "p", properties: {}, children }],
});

describe("legal citation links in an answer", () => {
  test("wraps a resolved citation in a plain link", () => {
    const tree = paragraph({
      type: "text",
      value: "Podle § 52 písm. g) ZP může zaměstnavatel…",
    });

    rehypeLegalCitationLinks([{ text: "§ 52 písm. g) ZP", url: ZP_URL }])(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          { type: "text", value: "Podle " },
          {
            type: "element",
            tagName: "a",
            properties: { href: ZP_URL },
            children: [{ type: "text", value: "§ 52 písm. g) ZP" }],
          },
          { type: "text", value: " může zaměstnavatel…" },
        ],
      },
    ]);
  });

  test("keeps a link the answer already made and leaves code alone", () => {
    const own = {
      type: "element",
      tagName: "a",
      properties: { href: "https://example.test/own" },
      children: [{ type: "text", value: "§ 52 písm. g) ZP" }],
    } satisfies ElementContent;
    const code = {
      type: "element",
      tagName: "code",
      properties: {},
      children: [{ type: "text", value: "§ 52 písm. g) ZP" }],
    } satisfies ElementContent;
    const tree = paragraph(own, code);

    rehypeLegalCitationLinks([{ text: "§ 52 písm. g) ZP", url: ZP_URL }])(tree);

    expect(tree).toEqual(paragraph(own, code));
  });

  test("the longer citation wins where one contains another", () => {
    const tree = paragraph({
      type: "text",
      value: "sp. zn. 21 Cdo 4733/2015",
    });

    rehypeLegalCitationLinks([
      { text: "21 Cdo 4733/2015", url: "https://app.example/short" },
      { text: "sp. zn. 21 Cdo 4733/2015", url: NS_URL },
    ])(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "a",
            properties: { href: NS_URL },
            children: [{ type: "text", value: "sp. zn. 21 Cdo 4733/2015" }],
          },
        ],
      },
    ]);
  });

  test("no pairs leave the tree untouched", () => {
    const tree = paragraph({ type: "text", value: "§ 52 ZP" });
    rehypeLegalCitationLinks([])(tree);
    expect(tree).toEqual(paragraph({ type: "text", value: "§ 52 ZP" }));
  });

  test("the rendered text is the answer as written", () => {
    const citations = ["§ 52 písm. g) ZP", "čl. 10 Listiny", "Pl. ÚS 1/20"];
    assertProperty(
      "legal citation links never change the rendered text",
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom(...citations),
            fc.string({ size: "xsmall" }),
            fc.constantFrom("(", ")", ".", " ", "§", "*", "\\"),
          ),
          { size: "small" },
        ),
        fc.subarray(citations),
        (pieces, linked) => {
          const value = pieces.join("");
          const tree = paragraph({ type: "text", value });
          rehypeLegalCitationLinks(
            linked.map((text) => ({ text, url: ZP_URL })),
          )(tree);
          expect(textContent(tree.children)).toBe(value);
        },
      ),
    );
  });
});
