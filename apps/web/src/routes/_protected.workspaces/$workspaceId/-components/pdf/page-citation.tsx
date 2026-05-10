import { useRef } from "react";

import { useShallow } from "zustand/react/shallow";

import type { BoundingBox } from "@stll/api/types";

import { usePDFStore } from "@/lib/pdf/pdf-context";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

const PAGE_HIGHLIGHT_FILTER_ID = "page-highlight-filter";
const PAGE_HIGHLIGHT_OPACITY = 0.2;
// % of the base PDF width in px
const HIGHLIGHT_PADDING_RATIO = 0.01;

const getBoundingBoxKey = (bBox: BoundingBox) =>
  `${bBox.pageNumber}-${bBox.xMin}-${bBox.yMin}-${bBox.xMax}-${bBox.yMax}`;

type PageCitationProps = {
  pageId: string;
  pageNumber: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
};

export const PageCitation = ({
  pageId,
  pageNumber,
  originalWidth,
  originalHeight,
  scale,
}: PageCitationProps) => {
  const justification = useWorkspaceStore((s) => s.activeJustification);
  const boundingBoxes = useWorkspaceStore(
    useShallow((s) => s.justifications.find((j) => j.id === justification?.id)),
  )?.boundingBoxes?.boxes.filter((b) => b.pageNumber === pageNumber);
  const [scrollTo, setScrollTo] = usePDFStore(
    useShallow((s) => [s.scrollTo, s.setScrollTo]),
  );
  const scrolledRef = useRef<string | null>(null);

  // Reset when the scroll target is consumed so the same
  // justification can be scrolled to again on re-click.
  if (scrollTo === null) {
    scrolledRef.current = null;
  }

  if (!justification || !boundingBoxes || boundingBoxes.length === 0) {
    return null;
  }

  const overlayWidth = originalWidth * scale;
  const overlayHeight = originalHeight * scale;
  const highlightPadding = originalWidth * HIGHLIGHT_PADDING_RATIO * scale;

  const topBoundingBox = boundingBoxes
    ?.toSorted((a, b) => a.yMin - b.yMin)
    .at(0);
  const topBoundingBoxKey = topBoundingBox
    ? getBoundingBoxKey(topBoundingBox)
    : null;

  return (
    <div
      aria-hidden={true}
      className="pointer-events-none absolute top-0 left-0 isolate"
      style={{
        filter: `url(#${PAGE_HIGHLIGHT_FILTER_ID})`,
        width: overlayWidth,
        height: overlayHeight,
      }}
    >
      {/* svg needs to be visible for the filter to work on firefox */}
      <svg
        aria-hidden={true}
        className="pointer-events-none absolute h-0 w-0"
        focusable="false"
      >
        <title>Page highlight filter</title>
        <filter colorInterpolationFilters="sRGB" id={PAGE_HIGHLIGHT_FILTER_ID}>
          <feComponentTransfer in="SourceGraphic">
            <feFuncA slope={PAGE_HIGHLIGHT_OPACITY} type="linear" />
          </feComponentTransfer>
        </filter>
      </svg>
      {boundingBoxes?.map((bBox) => {
        const { xMin, yMin, xMax, yMax } = bBox;
        const width = (xMax - xMin) * scale;
        const height = (yMax - yMin) * scale;
        const left = xMin * scale;
        const top = yMin * scale;
        const key = getBoundingBoxKey(bBox);

        return (
          <div
            className="rounded-xs bg-indigo-500"
            key={key}
            ref={(el) => {
              if (
                key === topBoundingBoxKey &&
                scrollTo?.target?.kind === "justification" &&
                scrollTo.target.id === justification.id &&
                scrollTo.pageId === pageId &&
                scrolledRef.current !== justification.id
              ) {
                scrolledRef.current = justification.id;
                el?.scrollIntoView({
                  block: "center",
                  inline: "center",
                });
                setScrollTo(null);
              }
            }}
            role="presentation"
            style={{
              position: "absolute",
              left: left - highlightPadding,
              top: top - highlightPadding,
              width: width + highlightPadding * 2,
              height: height + highlightPadding * 2,
            }}
          />
        );
      })}
    </div>
  );
};
