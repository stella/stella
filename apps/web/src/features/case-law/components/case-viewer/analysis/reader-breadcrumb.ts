import { useMemo } from "react";

import type { AnalysisHeading } from "@stll/legal-ast/analysis";

import type { ReaderBreadcrumbModel } from "@/components/legal-reader/reader-breadcrumb-paths";
import type { ReaderBreadcrumbSegment } from "@/components/legal-reader/reader-breadcrumb.logic";
import type { ReaderAnalysisOutline } from "@/components/legal-reader/reader-contents.logic";

import { getHeadingDisplayAnchorId } from "./types";

export const analysisReaderBreadcrumbPaths = (
  tree: readonly AnalysisHeading[],
): ReaderBreadcrumbModel => {
  const headings: ReaderBreadcrumbSegment[] = [];
  const paths = new Map<string, readonly ReaderBreadcrumbSegment[]>();
  const visit = (
    nodes: readonly AnalysisHeading[],
    ancestors: readonly ReaderBreadcrumbSegment[],
  ) => {
    for (const node of nodes) {
      const anchorId = getHeadingDisplayAnchorId(node);
      // Breadcrumb segments are keyed and matched by anchor. A heading that
      // starts at an anchor an outer heading already owns (a parent and its
      // first child on one paragraph) merges into that owner.
      const owner = paths.get(anchorId);
      if (owner !== undefined) {
        visit(node.children, owner);
        continue;
      }
      const entry = { anchorId, title: node.label };
      const path = [...ancestors, entry];
      headings.push(entry);
      paths.set(anchorId, path);
      visit(node.children, path);
    }
  };
  visit(tree, []);
  return { headings, paths };
};

// Both reader surfaces retain the same outline while the tree is unchanged;
// a streamed tree only grows, so its rows only join.
export const useAnalysisReaderOutline = (
  tree: readonly AnalysisHeading[] | null,
) =>
  useMemo(
    (): ReaderAnalysisOutline | undefined =>
      tree === null
        ? undefined
        : {
            disclosure: "caseLaw",
            sections: analysisReaderBreadcrumbPaths(tree),
          },
    [tree],
  );
