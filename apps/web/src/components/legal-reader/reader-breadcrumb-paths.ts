import { panic } from "better-result";

import { headingPathsByAnchor } from "@stll/legal-ast";
import type { Block } from "@stll/legal-ast/document-ast";

import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";

export type ReaderBreadcrumbModel = {
  paths: ReadonlyMap<string, readonly ReaderBreadcrumbSegment[]>;
  headings: readonly ReaderBreadcrumbSegment[];
};

/** The heading being read joins its shared enclosing path. */
export const readerBreadcrumbPaths = (
  blocks: readonly Block[],
): ReaderBreadcrumbModel => {
  const paths = new Map(headingPathsByAnchor(blocks));
  const headings = blocks.flatMap((block) => {
    if (block.type !== "heading") {
      return [];
    }
    const entry = { anchorId: block.anchorId, title: block.plainText };
    const ancestors = paths.get(block.anchorId);
    if (ancestors === undefined) {
      return panic("Shared heading path omitted a document anchor");
    }
    paths.set(block.anchorId, [...ancestors, entry]);
    return [entry];
  });
  return { paths, headings };
};
