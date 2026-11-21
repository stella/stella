import { expect, test } from "bun:test";

import { headingPathsByAnchor } from "@stll/legal-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import { readerBreadcrumbPaths } from "./reader-breadcrumb-paths";

const blocks = [
  {
    id: "intro",
    anchorId: "intro",
    type: "paragraph",
    plainText: "Introduction",
    inlines: [{ type: "text", text: "Introduction" }],
  },
  {
    id: "root",
    anchorId: "root",
    type: "heading",
    level: 1,
    plainText: "Odůvodnění",
    inlines: [{ type: "text", text: "Odůvodnění" }],
  },
  {
    id: "first",
    anchorId: "first",
    type: "heading",
    level: 2,
    plainText: "Posouzení",
    inlines: [{ type: "text", text: "Posouzení" }],
  },
  {
    id: "first-text",
    anchorId: "first-text",
    type: "paragraph",
    plainText: "First",
    inlines: [{ type: "text", text: "First" }],
  },
  {
    id: "second",
    anchorId: "second",
    type: "heading",
    level: 2,
    plainText: "Posouzení",
    inlines: [{ type: "text", text: "Posouzení" }],
  },
  {
    id: "second-text",
    anchorId: "second-text",
    type: "paragraph",
    plainText: "Second",
    inlines: [{ type: "text", text: "Second" }],
  },
] as const satisfies readonly Block[];

test("reader breadcrumb titles equal the shared passage paths at every anchor", () => {
  const shared = headingPathsByAnchor(blocks);
  const { paths, headings } = readerBreadcrumbPaths(blocks);
  expect([...paths.keys()]).toEqual([...shared.keys()]);
  for (const [anchorId, path] of paths) {
    const block = blocks.find((value) => value.anchorId === anchorId);
    const ancestors = shared.get(anchorId);
    if (ancestors === undefined) {
      throw new Error(`Shared path missing for ${anchorId}`);
    }
    expect(path).toEqual(
      block?.type === "heading"
        ? [...ancestors, { anchorId, title: block.plainText }]
        : ancestors,
    );
    for (const segment of path) {
      expect(headings).toContainEqual(segment);
    }
  }
});

test("reader breadcrumb binds repeated sibling titles to their own jump anchors", () => {
  const { paths } = readerBreadcrumbPaths(blocks);
  expect(paths.get("intro")).toEqual([]);
  expect(paths.get("first-text")?.map(({ anchorId }) => anchorId)).toEqual([
    "root",
    "first",
  ]);
  expect(paths.get("second-text")?.map(({ anchorId }) => anchorId)).toEqual([
    "root",
    "second",
  ]);
});
