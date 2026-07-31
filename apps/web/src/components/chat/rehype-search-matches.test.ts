import { describe, expect, test } from "bun:test";
import type { Root } from "hast";

import { rehypeSearchMatches } from "@/components/chat/rehype-search-matches";

describe("chat search highlighting", () => {
  test("highlights every normalized prose match", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "Odštěpení a odstepeni" }],
        },
      ],
    };

    rehypeSearchMatches({ searchText: "odštepení" })(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "mark",
            properties: { "data-search-match": "true" },
            children: [{ type: "text", value: "Odštěpení" }],
          },
          { type: "text", value: " a " },
          {
            type: "element",
            tagName: "mark",
            properties: { "data-search-match": "true" },
            children: [{ type: "text", value: "odstepeni" }],
          },
        ],
      },
    ]);
  });

  test("highlights visible text inside links and fenced code", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties: {},
          children: [{ type: "text", value: "needle" }],
        },
        {
          type: "element",
          tagName: "pre",
          properties: {},
          children: [{ type: "text", value: "needle" }],
        },
      ],
    };

    rehypeSearchMatches({ searchText: "needle" })(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "a",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "mark",
            properties: { "data-search-match": "true" },
            children: [{ type: "text", value: "needle" }],
          },
        ],
      },
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "mark",
            properties: { "data-search-match": "true" },
            children: [{ type: "text", value: "needle" }],
          },
        ],
      },
    ]);
  });
});
