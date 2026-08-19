import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import { extractProvisionText } from "@/api/handlers/legislation/provision-text";

const heading = (anchorId: string, level: 1 | 2 | 3, text: string): Block => ({
  id: `h-${anchorId}`,
  anchorId,
  type: "heading",
  level,
  inlines: [{ type: "text", text }],
  plainText: text,
});

const paragraph = (anchorId: string, text: string): Block => ({
  id: `p-${anchorId}`,
  anchorId,
  type: "paragraph",
  inlines: [{ type: "text", text }],
  plainText: text,
});

const blocks: Block[] = [
  heading("chapter-1", 1, "Chapter I"),
  paragraph("intro", "Introductory note."),
  heading("sec-1", 2, "Section 1"),
  paragraph("sec-1-1", "First rule."),
  heading("sec-1-a", 3, "Section 1a"),
  paragraph("sec-1-a-1", "Nested rule."),
  heading("sec-2", 2, "Section 2"),
  paragraph("sec-2-1", "Second rule."),
];

describe("extractProvisionText", () => {
  test("keeps the provision's own blocks and its nested subdivisions", () => {
    expect(extractProvisionText(blocks, "sec-1")).toBe(
      ["Section 1", "First rule.", "Section 1a", "Nested rule."].join("\n"),
    );
  });

  test("stops at the next heading of the same level", () => {
    expect(extractProvisionText(blocks, "sec-1")).not.toContain("Second rule.");
  });

  test("stops at a shallower heading", () => {
    expect(extractProvisionText(blocks, "sec-2")).toBe(
      ["Section 2", "Second rule."].join("\n"),
    );
  });

  test("takes everything under a top-level heading", () => {
    expect(extractProvisionText(blocks, "chapter-1")).toContain("Second rule.");
  });

  test("reads an unknown anchor as absent, not as empty", () => {
    expect(extractProvisionText(blocks, "sec-404")).toBeNull();
  });

  test("ignores an anchor that belongs to a paragraph, not a heading", () => {
    // Only a heading opens a provision; a paragraph anchor is a deep-link
    // target inside one.
    expect(extractProvisionText(blocks, "sec-1-1")).toBeNull();
  });
});
