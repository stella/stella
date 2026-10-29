import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("parser text projections cannot read inline leaves instead of the owner", async () => {
  expect(
    await lintSingleRule(
      "no-parser-inline-flatten",
      [
        'import type { Inline as Node } from "@stll/legal-ast/inline";',
        "const flatten = (inlines: readonly Node[]): string => {",
        '  let out = "";',
        "  for (const node of inlines) {",
        '    if (node.type === "text") out += node.text;',
        '    else if ("children" in node) out += flatten(node.children);',
        "  }",
        "  return out;",
        "};",
        'const mapped = (nodes: Node[]): string[] => nodes.filter((node) => node.type === "text").map(({ text }) => text);',
        'function declared(nodes: Node[]): string { return nodes.map((node) => node.type === "text" ? node["text"] : "").join(""); }',
      ].join("\n"),
    ),
  ).toEqual([5, 10, 11]);
});

test("parser projections delegate while inline transformations and source text stay available", async () => {
  expect(
    await lintSingleRule(
      "no-parser-inline-flatten",
      [
        'import type { Inline } from "@stll/legal-ast/inline";',
        'import { flattenInlineText } from "@stll/legal-ast/inline";',
        'import { plainTextOf } from "@stll/legal-ast/document-ast";',
        "const canonical = (nodes: readonly Inline[]): string => flattenInlineText(nodes);",
        "const rendered = (nodes: readonly Inline[]): string => plainTextOf(nodes);",
        'const transform = (nodes: Inline[]): Inline[] => nodes.map((node) => node.type === "text" ? { type: "text", text: node.text.trim() } : node);',
        "const xmlText = (node: XmlNode): string => node.text;",
      ].join("\n"),
    ),
  ).toEqual([]);
});
