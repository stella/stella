/**
 * Claim ranges over Folio's painted pages, and their highlights where the
 * browser has the CSS Custom Highlight API. The ranges are what a click is
 * matched against, so they are built whether or not anything can be painted.
 */

import { findBodyPmSpans } from "@stll/folio-core/layout-bridge/dom/findBodyPmSpans";
import {
  createTextStreamRange,
  descendantTextNodes,
  totalTextLength,
} from "@stll/folio-core/layout-bridge/dom/textStreamDom";
import type { TextMarkState } from "@stll/ui/text-mark";

import {
  claimAtPoint,
  claimHighlightName,
  paintedSegments,
} from "@/features/avt/original-docx.logic";
import type { Box, LocatedClaim } from "@/features/avt/original-docx.logic";
import type { ClaimState, VerificationClaim } from "@/features/avt/types";

/** Each mark's highlight priority: the selected claim paints over the rest. */
export const MARK_PRIORITY = {
  rest: 0,
  matched: 1,
  active: 2,
} as const satisfies Record<TextMarkState, number>;

/** The registry calls the view makes; absent where the browser lacks them. */
export type HighlightApi = {
  set: (name: string, ranges: readonly Range[], priority: number) => void;
  delete: (name: string) => void;
};

/** The part of a highlight the view sets. */
type PaintedHighlight = { priority: number };

/** The part of `CSS.highlights` the view calls, for its highlight type. */
type PaintRegistry<H extends PaintedHighlight> = {
  set: (name: string, highlight: H) => unknown;
  delete: (name: string) => unknown;
};

/**
 * The globals the API lives on, optional because not every browser has them,
 * and narrowed to the members the view uses. The registry takes the
 * highlights its own constructor makes.
 */
type HighlightEnv<H extends PaintedHighlight> = {
  Highlight?: (new (...ranges: Range[]) => H) | undefined;
  CSS?: { highlights?: PaintRegistry<H> | undefined } | undefined;
};

/**
 * The Custom Highlight API when both halves exist (the `Highlight`
 * constructor and the `CSS.highlights` registry), otherwise null: the
 * original then shows unmarked and stays clickable.
 */
export const resolveHighlightApi = <H extends PaintedHighlight>(
  env: HighlightEnv<H>,
): HighlightApi | null => {
  const HighlightConstructor = env.Highlight;
  const registry = env.CSS?.highlights;
  if (typeof HighlightConstructor !== "function" || registry === undefined) {
    return null;
  }
  return {
    set: (name, ranges, priority) => {
      const highlight = new HighlightConstructor(...ranges);
      highlight.priority = priority;
      registry.set(name, highlight);
    },
    delete: (name) => {
      registry.delete(name);
    },
  };
};

type ClaimPaint = {
  location: LocatedClaim;
  state: ClaimState;
  mark: TextMarkState | null;
};

type PaintClaimRangesArgs = {
  root: ParentNode;
  marks: readonly ClaimPaint[];
  scope: string;
  api: HighlightApi | null;
};

/**
 * Build every claim's DOM ranges from the runs painted now and, when the API
 * exists, register each verdict and mark's highlight. Returns the ranges by
 * claim for hit-testing clicks.
 */
export const paintClaimRanges = ({
  root,
  marks,
  scope,
  api,
}: PaintClaimRangesArgs): Map<VerificationClaim["id"], Range[]> => {
  const spanElements = findBodyPmSpans(root);
  const spans = spanElements.map((element) => ({
    pmStart: Number(element.dataset["pmStart"]),
    pmEnd: Number(element.dataset["pmEnd"]),
  }));
  const byName = new Map<string, { ranges: Range[]; priority: number }>();
  const ranges = new Map<VerificationClaim["id"], Range[]>();
  for (const { location, state, mark } of marks) {
    const claimRanges: Range[] = [];
    for (const segment of paintedSegments(spans, location)) {
      const element = spanElements.at(segment.spanIndex);
      if (element === undefined) {
        continue;
      }
      const length = totalTextLength(descendantTextNodes(element));
      const range = createTextStreamRange(
        element,
        segment.start,
        Math.min(segment.end, length),
      );
      if (range !== null) {
        claimRanges.push(range);
      }
    }
    ranges.set(location.claimId, claimRanges);
    if (mark === null || claimRanges.length === 0) {
      continue;
    }
    const name = claimHighlightName(scope, state, mark);
    const entry = byName.get(name) ?? {
      ranges: [],
      priority: MARK_PRIORITY[mark],
    };
    entry.ranges.push(...claimRanges);
    byName.set(name, entry);
  }
  if (api !== null) {
    for (const [name, entry] of byName) {
      api.set(name, entry.ranges, entry.priority);
    }
  }
  return ranges;
};

/** The claim whose painted words are under a viewport point, if any. */
export const claimUnderPoint = (
  rangesByClaim: ReadonlyMap<VerificationClaim["id"], readonly Range[]>,
  point: { x: number; y: number },
): VerificationClaim["id"] | null => {
  const boxes = new Map<VerificationClaim["id"], Box[]>();
  for (const [id, ranges] of rangesByClaim) {
    boxes.set(
      id,
      ranges.flatMap((range) => [...range.getClientRects()]),
    );
  }
  return claimAtPoint(boxes, point);
};
