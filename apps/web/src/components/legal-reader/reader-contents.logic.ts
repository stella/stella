import { panic } from "better-result";

import type { AiDisclosureContext } from "@stll/api-contract/ai-disclosure";

import type { ReaderBreadcrumbModel } from "./reader-breadcrumb-paths";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";

/** Sections a model wrote over the document, each keyed by the block it starts at. */
export type ReaderAnalysisOutline = {
  disclosure: AiDisclosureContext;
  sections: ReaderBreadcrumbModel;
};

export type ReaderContentsRow =
  | { type: "heading"; anchorId: string; title: string }
  | {
      type: "analysis";
      anchorId: string;
      title: string;
      disclosure: AiDisclosureContext;
    }
  | {
      type: "headingWithAnalysis";
      anchorId: string;
      /** The document's own heading; the model's title never replaces it. */
      title: string;
      analysisTitle: string;
      disclosure: AiDisclosureContext;
    };

export type ReaderContents = {
  rows: readonly ReaderContentsRow[];
  /** The breadcrumb trail while each row's anchor is the one being read. */
  trails: ReadonlyMap<string, readonly ReaderBreadcrumbSegment[]>;
};

type ReaderContentsOptions = {
  /** Every block anchor of the document, in reading order. */
  anchorOrder: readonly string[];
  headings: ReaderBreadcrumbModel;
  analysis: ReaderAnalysisOutline | undefined;
};

type PlacedSection = { title: string; disclosure: AiDisclosureContext };

const placedSections = ({
  analysis,
  position,
}: {
  analysis: ReaderAnalysisOutline | undefined;
  position: ReadonlyMap<string, number>;
}) => {
  const placed = new Map<string, PlacedSection>();
  if (analysis === undefined) {
    return placed;
  }
  for (const { anchorId, title } of analysis.sections.headings) {
    // Model output can name an anchor this document lacks: such a section
    // has no place in the text, so it has no row. The first section at an
    // anchor keeps it, so a later one never renames a row already shown.
    if (!position.has(anchorId) || placed.has(anchorId)) {
      continue;
    }
    placed.set(anchorId, { title, disclosure: analysis.disclosure });
  }
  return placed;
};

/**
 * One outline in reading order: the document's headings, always and as
 * written, with the model's sections placed among them by anchor. A section
 * that starts at a heading shares that heading's row.
 */
export const readerContents = ({
  anchorOrder,
  headings,
  analysis,
}: ReaderContentsOptions): ReaderContents => {
  const position = new Map(
    anchorOrder.map((anchorId, index) => [anchorId, index]),
  );
  const sections = placedSections({ analysis, position });
  const rows = headings.headings.map(
    ({ anchorId, title }): ReaderContentsRow => {
      const section = sections.get(anchorId);
      return section === undefined
        ? { type: "heading", anchorId, title }
        : {
            type: "headingWithAnalysis",
            anchorId,
            title,
            analysisTitle: section.title,
            disclosure: section.disclosure,
          };
    },
  );
  const headingAnchors = new Set(rows.map(({ anchorId }) => anchorId));
  for (const [anchorId, { title, disclosure }] of sections) {
    if (!headingAnchors.has(anchorId)) {
      rows.push({ type: "analysis", anchorId, title, disclosure });
    }
  }
  const at = (anchorId: string) =>
    position.get(anchorId) ?? panic("Contents row names no document block");
  const ordered = rows.toSorted(
    (left, right) => at(left.anchorId) - at(right.anchorId),
  );

  // Without headings of its own, the document's trail is the analysis
  // outline's; otherwise a section keeps the trail of the heading it is in.
  const analysisTrails =
    headings.headings.length === 0 ? analysis?.sections.paths : undefined;
  const trails = new Map<string, readonly ReaderBreadcrumbSegment[]>();
  let enclosing: readonly ReaderBreadcrumbSegment[] = [];
  for (const row of ordered) {
    switch (row.type) {
      case "heading":
      case "headingWithAnalysis": {
        enclosing =
          headings.paths.get(row.anchorId) ??
          panic("Document heading has no breadcrumb path");
        trails.set(row.anchorId, enclosing);
        break;
      }
      case "analysis": {
        trails.set(
          row.anchorId,
          analysisTrails === undefined
            ? enclosing
            : (analysisTrails.get(row.anchorId) ??
                panic("Analysis section has no breadcrumb path")),
        );
        break;
      }
      default: {
        row satisfies never;
        panic("Unhandled contents row");
      }
    }
  }
  return { rows: ordered, trails };
};
