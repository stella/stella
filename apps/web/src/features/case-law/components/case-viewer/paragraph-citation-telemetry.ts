import type { AnalysisAnchorRange } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import type { Analytics } from "@/lib/analytics/types";
import { ClientTelemetryError } from "@/lib/errors/telemetry";

import { paragraphRangeIndices } from "./paragraph-reference.logic";

// Ranges already reported, per analytics client (one per page load), so a
// remounted reader or a reopened decision never reports a range twice.
const reportedRanges = new WeakMap<Analytics, Set<string>>();

type UnresolvedCitationTelemetryOptions = {
  blocks: readonly Block[];
  ranges: readonly AnalysisAnchorRange[];
  /** What cites the ranges: an analysis's input, or a decision's answers. */
  source: string;
};

/**
 * Reports cited ranges the loaded text cannot resolve. Analyses and reader
 * answers cite this text, so a citation that misses it is a data defect;
 * the reader draws no reference for it.
 */
export const useUnresolvedCitationTelemetry = ({
  blocks,
  ranges,
  source,
}: UnresolvedCitationTelemetryOptions) => {
  const analytics = useAnalytics();
  useExternalSyncEffect(() => {
    let reported = reportedRanges.get(analytics);
    if (reported === undefined) {
      reported = new Set();
      reportedRanges.set(analytics, reported);
    }
    let fresh = 0;
    for (const range of ranges) {
      if (paragraphRangeIndices(blocks, range) !== null) {
        continue;
      }
      const key = JSON.stringify([
        source,
        range.startAnchorId,
        range.endAnchorId,
      ]);
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      fresh += 1;
    }
    if (fresh === 0) {
      return;
    }
    analytics.captureError(
      new ClientTelemetryError({
        area: "case-law-paragraph-citation",
        message:
          "[Paragraph citation] A citation names a paragraph the decision text does not contain",
      }),
      {
        fingerprintKey: "useUnresolvedCitationTelemetry:ClientTelemetryError",
        scope: { type: "handler", handlerId: "case-law.paragraph-citation" },
      },
    );
  }, [analytics, blocks, ranges, source]);
};
