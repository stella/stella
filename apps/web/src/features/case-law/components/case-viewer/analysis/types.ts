import type { AnalysisHeading } from "@stll/legal-ast/analysis";

import { getCategoryVar } from "@/components/legal-reader/category-color";

export type { AnalysisHeading } from "@stll/legal-ast/analysis";

export type FlatAnalysisHeading = AnalysisHeading & {
  depth: number;
};

/**
 * Section info per anchor: CSS variable + heading ID for grouping.
 */
export type SectionInfo = { cssVar: string; headingId: string };

export const buildSectionMap = (
  headings: readonly AnalysisHeading[],
  allAnchorIds: readonly string[],
): Map<string, SectionInfo> => {
  const map = new Map<string, SectionInfo>();
  const idxMap = new Map(allAnchorIds.map((id, i) => [id, i]));

  const mapRange = ({
    cssVar,
    endAnchorId,
    headingId,
    startAnchorId,
  }: {
    cssVar: string;
    endAnchorId: string;
    headingId: string;
    startAnchorId: string;
  }) => {
    const start = idxMap.get(startAnchorId);
    const end = idxMap.get(endAnchorId);
    if (start === undefined || end === undefined) {
      return;
    }

    for (let i = start; i <= end; i++) {
      const anchorId = allAnchorIds[i];
      if (anchorId && !map.has(anchorId)) {
        map.set(anchorId, { cssVar, headingId });
      }
    }
  };

  const walk = (nodes: readonly AnalysisHeading[]) => {
    for (const node of nodes) {
      const cssVar = getCategoryVar(node.category);
      for (const annotation of node.annotations) {
        mapRange({
          cssVar,
          endAnchorId: annotation.endAnchorId,
          headingId: annotation.id,
          startAnchorId: annotation.startAnchorId,
        });
      }
      walk(node.children);
    }
  };

  walk(headings);
  return map;
};

/** The first annotation is where the reader displays the section heading. */
export const getHeadingDisplayAnchorId = ({
  annotations,
  startAnchorId,
}: Pick<AnalysisHeading, "annotations" | "startAnchorId">): string =>
  annotations.at(0)?.startAnchorId ?? startAnchorId;

export const flattenAnalysisHeadings = (
  headings: readonly AnalysisHeading[],
): FlatAnalysisHeading[] => {
  const result: FlatAnalysisHeading[] = [];

  const walk = (nodes: readonly AnalysisHeading[], depth: number) => {
    for (const node of nodes) {
      result.push({ ...node, depth });
      walk(node.children, depth + 1);
    }
  };

  walk(headings, 0);
  return result;
};
