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
  /** What the side says when it quotes nothing; see `ReviewAlignedPairSide`. */
  emptyLabel?: string | undefined;
};

export type ReviewDeltaViewProps = {
  label: string;
  delta: ReviewDelta;
  impact: ReviewImpact;
  target: ReviewDeltaSide;
  standard: ReviewDeltaSide;
  onShowInDocument?: ((blockId: string) => void) | undefined;
  /** Opens a standard passage in the reference it was quoted from. */
  onShowStandardPassage?: ((blockId: string) => void) | undefined;
  /** Names the reference the standard was read from, e.g.
   *  `Standard (Master NDA)`. Falls back to `standard.label`. */
  standardLabel?: string | undefined;
};

/**
 * A graded finding, read top down: what the delta claims, then the passages
 * it claims it about. The summary shape is the delta's own — a term row for a
 * parameter, a presence matrix for an enumeration — and the aligned pair
 * always follows it, because a reviewer who cannot see the wording cannot
 * check the claim.
 */
export const ReviewDeltaView = ({
  label,
  delta,
  impact,
  target,
  standard,
  onShowInDocument,
  onShowStandardPassage,
  standardLabel,
}: ReviewDeltaViewProps) => {
  const standardHeading = standardLabel ?? standard.label;
  // A parameter delta names the exact phrase that differs on each side, so
  // the pair can mark that phrase rather than every figure in the passage.
  const pair = (
    <ReviewAlignedPair
      delta={delta.kind === "parameter" ? delta : undefined}
      onShowInDocument={onShowInDocument}
      onShowStandardPassage={onShowStandardPassage}
      standard={standard}
      standardLabel={standardHeading}
      target={target}
    />
  );

  switch (delta.kind) {
    case "parameter":
      return (
        <div className="space-y-3">
          <ReviewTermTable
            onShowInDocument={onShowInDocument}
            rows={[{ delta, id: label, impact, label }]}
            standardLabel={standardHeading}
            targetLabel={target.label}
          />
          {pair}
        </div>
      );
    case "enumeration":
    case "presence":
      return (
        <div className="space-y-3">
          <ReviewPresenceMatrix
            delta={delta}
            onShowInDocument={onShowInDocument}
            standardLabel={standardHeading}
            targetLabel={target.label}
          />
          {pair}
        </div>
      );
    case "language":
      return pair;
    default:
      delta satisfies never;
      return null;
  }
};
