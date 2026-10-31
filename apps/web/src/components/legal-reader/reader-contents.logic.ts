import { panic } from "better-result";

import type { AiDisclosureContext } from "@stll/api-contract/ai-disclosure";
import { comparableHeadingTitle } from "@stll/legal-ast/source-contents";

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

/** The breadcrumb trail, and whether the document or a model titled it. */
export type ReaderTrail =
  | { type: "document"; segments: readonly ReaderBreadcrumbSegment[] }
  | {
      type: "analysis";
      segments: readonly ReaderBreadcrumbSegment[];
      disclosure: AiDisclosureContext;
    };

export type ReaderContents = {
  rows: readonly ReaderContentsRow[];
  /** The breadcrumb trail while each row's anchor is the one being read. */
  trails: ReadonlyMap<string, ReaderTrail>;
  /**
   * How far each row is indented: a heading by the headings enclosing it, a
   * model's section one step inside the heading it sits under, the shallowest
   * row at zero. A judgment repeats a subheading under each ground it answers
   * (`– Arguments of the parties`), and the indent is what tells the copies
   * apart in one list.
   */
  depths: ReadonlyMap<string, number>;
};

type ReaderContentsOptions = {
  /** Every block anchor of the document, in reading order. */
  anchorOrder: readonly string[];
  headings: ReaderBreadcrumbModel;
  analysis: ReaderAnalysisOutline | undefined;
};

type PlacedSection = { title: string; disclosure: AiDisclosureContext };

/**
 * The document heading a model's section belongs to, when it has one.
 *
 * A section starting at a heading belongs to it. So does a section titled as
 * a heading is, when nothing but text lies between the two: a model starts a
 * section at the first passage under the heading (or at the publisher's own
 * contents line naming it), not on the heading itself, and the same part of
 * the text should not be listed twice. A section whose block the reader does
 * not show (that contents line, left out of the view) belongs to the first
 * heading of its title.
 */
const sectionHeadingAnchor = ({
  anchorId,
  title,
  headingAnchors,
  headings,
  position,
}: {
  anchorId: string;
  title: string;
  headingAnchors: ReadonlySet<string>;
  headings: ReaderBreadcrumbModel["headings"];
  position: ReadonlyMap<string, number>;
}): string | undefined => {
  if (headingAnchors.has(anchorId)) {
    return anchorId;
  }
  const comparable = comparableHeadingTitle(title);
  const at = position.get(anchorId);
  if (at === undefined) {
    return headings.find(
      (heading) => comparableHeadingTitle(heading.title) === comparable,
    )?.anchorId;
  }
  // Headings are in reading order: the one enclosing the section's block and
  // the one right after it are its only neighbours with no heading between.
  const after = headings.findIndex(
    (heading) => (position.get(heading.anchorId) ?? -1) > at,
  );
  const enclosing = after === -1 ? headings.at(-1) : headings.at(after - 1);
  const next = after === -1 ? undefined : headings.at(after);
  return [after === 0 ? undefined : enclosing, next].find(
    (heading) =>
      heading !== undefined &&
      comparableHeadingTitle(heading.title) === comparable,
  )?.anchorId;
};

const placedSections = ({
  analysis,
  headings,
  position,
}: {
  analysis: ReaderAnalysisOutline | undefined;
  headings: ReaderBreadcrumbModel["headings"];
  position: ReadonlyMap<string, number>;
}) => {
  const placed = new Map<string, PlacedSection>();
  if (analysis === undefined) {
    return placed;
  }
  const headingAnchors = new Set(headings.map(({ anchorId }) => anchorId));
  for (const { anchorId, title } of analysis.sections.headings) {
    const rowAnchor =
      sectionHeadingAnchor({
        anchorId,
        title,
        headingAnchors,
        headings,
        position,
      }) ?? anchorId;
    // Model output can name an anchor this document lacks, or does not
    // show: such a section has no place in the text, so it has no row. The
    // first section at a row keeps it, so a later one never renames a row
    // already shown.
    if (!position.has(rowAnchor) || placed.has(rowAnchor)) {
      continue;
    }
    placed.set(rowAnchor, { title, disclosure: analysis.disclosure });
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
  const sections = placedSections({
    analysis,
    headings: headings.headings,
    position,
  });
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
  const trails = new Map<string, ReaderTrail>();
  const nesting = new Map<string, number>();
  let enclosing: ReaderTrail = { type: "document", segments: [] };
  for (const row of ordered) {
    switch (row.type) {
      case "heading":
      case "headingWithAnalysis": {
        enclosing = {
          type: "document",
          segments:
            headings.paths.get(row.anchorId) ??
            panic("Document heading has no breadcrumb path"),
        };
        trails.set(row.anchorId, enclosing);
        // A heading's path ends with the heading itself.
        nesting.set(row.anchorId, enclosing.segments.length - 1);
        break;
      }
      case "analysis": {
        nesting.set(row.anchorId, enclosing.segments.length);
        trails.set(
          row.anchorId,
          analysisTrails === undefined
            ? enclosing
            : {
                type: "analysis",
                segments:
                  analysisTrails.get(row.anchorId) ??
                  panic("Analysis section has no breadcrumb path"),
                disclosure: row.disclosure,
              },
        );
        break;
      }
      default: {
        row satisfies never;
        panic("Unhandled contents row");
      }
    }
  }
  const shallowest = Math.min(...nesting.values());
  const depths = new Map(
    [...nesting].map(([anchorId, depth]) => [anchorId, depth - shallowest]),
  );
  return { rows: ordered, trails, depths };
};
