import { expect, test } from "bun:test";
import type { Element, Root } from "hast";

import { rehypeChatLinks } from "./link-markdown";

test("chat markdown links preserve text and source anchors with safe destinations", () => {
  const anchor: Element = {
    type: "element",
    tagName: "span",
    properties: {
      "data-src-start": 0,
      "data-src-end": 23,
      "data-src-offsets": "0,1,2",
    },
    children: [{ type: "text", value: "See stll.app and § 1.2." }],
  };
  const tree: Root = { type: "root", children: [anchor] };
  rehypeChatLinks()(tree);
  expect(anchor.properties).toEqual({
    "data-src-start": 0,
    "data-src-end": 23,
    "data-src-offsets": "0,1,2",
  });
  expect(anchor.children).toEqual([
    { type: "text", value: "See " },
    {
      type: "element",
      tagName: "a",
      properties: {
        href: "https://stll.app/",
        target: "_blank",
        rel: ["noopener", "noreferrer"],
      },
      children: [{ type: "text", value: "stll.app" }],
    },
    { type: "text", value: " and § 1.2." },
  ]);
  const once = structuredClone(tree);
  rehypeChatLinks()(tree);
  expect(tree).toEqual(once);
});

test("chat markdown links leave existing links, code and anonymized spans untouched", () => {
  const tree: Root = {
    type: "root",
    children: ["a", "code", "pre", "stll-anon"].map((tagName) => ({
      type: "element",
      tagName,
      properties: {},
      children: [
        {
          type: "element",
          tagName: "span",
          properties: {},
          children: [{ type: "text", value: "stll.app" }],
        },
      ],
    })),
  };
  const original = structuredClone(tree);
  rehypeChatLinks()(tree);
  expect(tree).toEqual(original);
});

test("chat markdown links never create anchors for unsafe or ambiguous text", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "text",
        value: "report.zip user@stll.app https://user:password@stll.app § 1.2",
      },
    ],
  };
  const original = structuredClone(tree);
  rehypeChatLinks()(tree);
  expect(tree).toEqual(original);
});
