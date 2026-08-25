import { ReviewAlignedPair } from "@/components/ai-suggestions/review-aligned-pair";
import type {
  DeltaCitation,
  ReviewDelta,
  ReviewImpact,
} from "@/components/ai-suggestions/review-delta";
import { ReviewPresenceMatrix } from "@/components/ai-suggestions/review-presence-matrix";
import { ReviewTermTable } from "@/components/ai-suggestions/review-term-row";

export type ReviewDeltaSide = {
  label: string;
  passages: readonly DeltaCitation[];
};

export type ReviewDeltaViewProps = {
  label: string;
  delta: ReviewDelta;
  impact: ReviewImpact;
  target: ReviewDeltaSide;
  standard: ReviewDeltaSide;
  onShowInDocument?: ((blockId: string) => void) | undefined;
};

/**
 * Dispatches a graded finding's delta to the component that renders its
 * shape: a term row for a single parameter, a presence matrix for an
 * enumeration or a bare term, an aligned pair for anything without a
 * structured delta. There is no generic "finding card" here on purpose —
 * the delta's kind fully determines the layout.
 */
export const ReviewDeltaView = ({
  label,
  delta,
  impact,
  target,
  standard,
  onShowInDocument,
}: ReviewDeltaViewProps) => {
  switch (delta.kind) {
    case "parameter":
      return (
        <ReviewTermTable
          onShowInDocument={onShowInDocument}
          rows={[{ delta, id: label, impact, label }]}
          standardLabel={standard.label}
          targetLabel={target.label}
        />
      );
    case "enumeration":
    case "presence":
      return (
        <ReviewPresenceMatrix
          delta={delta}
          onShowInDocument={onShowInDocument}
          standardLabel={standard.label}
          targetLabel={target.label}
        />
      );
    case "language":
      return (
        <ReviewAlignedPair
          diff
          onShowInDocument={onShowInDocument}
          standard={standard}
          target={target}
        />
      );
    default:
      delta satisfies never;
      return null;
  }
};
