import { describe, expect, test } from "bun:test";
import type { Root } from "hast";

import {
  allocateSearchMatchBudgets,
  rehypeSearchMatches,
} from "@/components/chat/rehype-search-matches";

const TEST_MAX_MATCHES = 200;

describe("chat search highlighting", () => {
  test("shares one immutable match budget across preview messages", () => {
    expect(
      allocateSearchMatchBudgets({
        contents: ["hit ".repeat(150), "hit ".repeat(100), "hit ".repeat(10)],
        maxMatches: 201,
        searchText: "hit",
      }),
    ).toEqual([150, 51, 0]);
  });

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

    rehypeSearchMatches({
      maxMatches: TEST_MAX_MATCHES,
      searchText: "odštepení",
    })(tree);

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

  test("unions exact and normalized hits without duplicating exact spans", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "odstepeni odštěpení ODŠTĚPENÍ" }],
        },
      ],
    };

    rehypeSearchMatches({
      maxMatches: TEST_MAX_MATCHES,
      searchText: "odštěpení",
    })(tree);

    const paragraph = tree.children.at(0);
    expect(paragraph).toMatchObject({
      children: [
        {
          type: "element",
          children: [{ value: "odstepeni" }],
        },
        { type: "text", value: " " },
        {
          type: "element",
          children: [{ value: "odštěpení" }],
        },
        { type: "text", value: " " },
        {
          type: "element",
          children: [{ value: "ODŠTĚPENÍ" }],
        },
      ],
    });
  });

  test("highlights context-sensitive case mappings", () => {
    const tree: Root = {
      type: "root",
      children: [{ type: "text", value: "ΟΣ" }],
    };

    rehypeSearchMatches({
      maxMatches: TEST_MAX_MATCHES,
      searchText: "ος",
    })(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "mark",
        properties: { "data-search-match": "true" },
        children: [{ type: "text", value: "ΟΣ" }],
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

    rehypeSearchMatches({
      maxMatches: TEST_MAX_MATCHES,
      searchText: "needle",
    })(tree);

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

  test("stops constructing highlight nodes at the requested cap", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "hit ".repeat(300) }],
        },
      ],
    };

    rehypeSearchMatches({
      maxMatches: 3,
      searchText: "hit",
    })(tree);

    const paragraph = tree.children.at(0);
    expect(paragraph).toMatchObject({
      children: [
        { type: "element" },
        { type: "text", value: " " },
        { type: "element" },
        { type: "text", value: " " },
        { type: "element" },
        { type: "text", value: expect.stringContaining("hit") },
      ],
    });
  });

  test("resets the immutable cap when a transform is replayed", () => {
    const createTree = (): Root => ({
      type: "root",
      children: [{ type: "text", value: "hit hit hit hit" }],
    });
    const transform = rehypeSearchMatches({
      maxMatches: 3,
      searchText: "hit",
    });
    const first = createTree();
    const replay = createTree();

    transform(first);
    transform(replay);

    const countMarks = (tree: Root) =>
      tree.children.filter(
        (child) => child.type === "element" && child.tagName === "mark",
      ).length;
    expect(countMarks(first)).toBe(3);
    expect(countMarks(replay)).toBe(3);
  });
});
