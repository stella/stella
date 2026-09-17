import { useId } from "react";

import type { CitationTreatment } from "@/features/case-law/citation-treatment";

/**
 * Negative treatment is the one figure a reader must not miss, and red
 * against green is the colour-blind reader's hard pair. So every citation
 * graphic hatches it as well as colouring it: colour alone fails a
 * colour-blind reader, a monochrome print, and forced-colours mode.
 *
 * One pattern for the strip and the timeline chart, so a year that looks
 * hatched at a glance looks hatched when it is opened.
 */
const HATCH_SIZE = 3;

/**
 * A pattern id this graphic owns. `useId` is unique per instance, but React
 * writes it with characters no URL fragment should carry, and the fill is
 * referenced as `url(#id)`; the strip renders wherever a decision is named,
 * so the reference has to hold outside this app's own pages too.
 */
export const useCitationHatchId = (): string =>
  `citation-negative-${useId().replaceAll(/[^\w-]/gu, "")}`;

type CitationNegativeHatchProps = {
  id: string;
  /**
   * The surface the graphic sits on, as a stroke class: the hatch is drawn
   * by cutting the surface back through the fill, so it has to be that
   * surface's own colour.
   */
  surfaceClassName: string;
};

export const CitationNegativeHatch = ({
  id,
  surfaceClassName,
}: CitationNegativeHatchProps) => (
  <defs>
    <pattern
      height={HATCH_SIZE}
      id={id}
      patternTransform="rotate(45)"
      patternUnits="userSpaceOnUse"
      width={HATCH_SIZE}
    >
      <rect
        className="fill-destructive"
        height={HATCH_SIZE}
        width={HATCH_SIZE}
      />
      <line
        className={surfaceClassName}
        strokeWidth="1.25"
        x1="0"
        x2="0"
        y1="0"
        y2={HATCH_SIZE}
      />
    </pattern>
  </defs>
);

/** The hatch a negative segment takes; every other treatment takes its token. */
export const negativeHatchFill = (
  treatment: CitationTreatment,
  hatchId: string,
): string | undefined =>
  treatment === "negative" ? `url(#${hatchId})` : undefined;
