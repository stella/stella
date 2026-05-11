import { describe, expect, test } from "bun:test";
import type { Root } from "hast";

import { rehypeAnonSpans } from "@/components/chat/rehype-anon-spans";

const pairs = [{ placeholder: "[PERSON_1]", original: "Jan Novak" }];

describe("rehype anonymization spans", () => {
  test("wraps restored text in prose", () => {
    const tree: Root = {
      type: "root",
      children: [{ type: "text", value: "Jan Novak signed." }],
    };

    rehypeAnonSpans(pairs)(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "stll-anon",
        properties: { ph: "[PERSON_1]" },
        children: [{ type: "text", value: "Jan Novak" }],
      },
      { type: "text", value: " signed." },
    ]);
  });

  test("does not inject interactive pills inside links", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "a",
          properties: { href: "#stella-entity=123" },
          children: [{ type: "text", value: "Jan Novak" }],
        },
      ],
    };

    rehypeAnonSpans(pairs)(tree);

    expect(tree.children).toEqual([
      {
        type: "element",
        tagName: "a",
        properties: { href: "#stella-entity=123" },
        children: [{ type: "text", value: "Jan Novak" }],
      },
    ]);
  });
});
