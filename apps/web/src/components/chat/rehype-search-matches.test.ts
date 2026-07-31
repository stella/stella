import { describe, expect, test } from "bun:test";
import type { Root } from "hast";

import { rehypeSearchMatches } from "@/components/chat/rehype-search-matches";

const TEST_MAX_MATCHES = 200;

const createMatchBudget = (remaining = TEST_MAX_MATCHES) => ({ remaining });

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

    rehypeSearchMatches({
      matchBudget: createMatchBudget(),
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
      matchBudget: createMatchBudget(),
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
      matchBudget: createMatchBudget(),
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
      matchBudget: createMatchBudget(),
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
      matchBudget: createMatchBudget(3),
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

  test("shares one match budget across separately rendered messages", () => {
    const first: Root = {
      type: "root",
      children: [{ type: "text", value: "hit hit" }],
    };
    const second: Root = {
      type: "root",
      children: [{ type: "text", value: "hit hit" }],
    };
    const matchBudget = createMatchBudget(3);

    rehypeSearchMatches({ matchBudget, searchText: "hit" })(first);
    rehypeSearchMatches({ matchBudget, searchText: "hit" })(second);

    const countMarks = (tree: Root) =>
      tree.children.filter(
        (child) => child.type === "element" && child.tagName === "mark",
      ).length;
    expect(countMarks(first) + countMarks(second)).toBe(3);
    expect(matchBudget.remaining).toBe(0);
  });
});
