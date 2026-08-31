import { cn } from "@stll/ui/utils";

import type { DeltaCitation } from "@/components/ai-suggestions/review-delta";
import { buildMarkedPair } from "@/components/ai-suggestions/review-key-terms";
import { ReviewPassageSide } from "@/components/ai-suggestions/review-passage-side";
import type { ParameterDelta } from "@/components/ai-suggestions/review-term-row";

/** The width past which the card can hold two readable columns. */
const SIDE_BY_SIDE_GRID_CLASS =
  "@min-[40rem]/review-pair:grid-cols-2 @min-[40rem]/review-pair:gap-x-6";

export type ReviewAlignedPairSide = {
  label: string;
  passages: readonly DeltaCitation[];
  /** What the side says when it quotes nothing. A standard whose passages
   *  belong to a matter this reader cannot open says that, rather than the
   *  "no passage" that would claim the standard quoted none. */
  emptyLabel?: string | undefined;
};

export type ReviewAlignedPairProps = {
  target: ReviewAlignedPairSide;
  standard: ReviewAlignedPairSide;
  onShowInDocument?: ((blockId: string) => void) | undefined;
  /** Opens a standard passage where it lives — the reference document it was
   *  quoted from. Absent when the standard is authored language, which has no
   *  document to open. */
  onShowStandardPassage?: ((blockId: string) => void) | undefined;
  /** Names the reference the standard was read from, e.g.
   *  `Standard (Master NDA)`. Falls back to `standard.label`. */
  standardLabel?: string | undefined;
  /** The finding's parameter delta, when it names the exact phrase that
   *  differs on each side. That phrase then carries the strongest mark. */
  delta?: ParameterDelta | undefined;
};

/**
 * Two passages to read, not a verdict about them: each side is one continuous
 * prose block with its clause numbers hanging in the margin, and the words
 * that carry the difference marked in place on both sides at once.
 *
 * Side by side only where the card is wide enough to hold two readable
 * measures; below that the standard stacks under a rule.
 */
export const ReviewAlignedPair = ({
  target,
  standard,
  onShowInDocument,
  onShowStandardPassage,
  standardLabel,
  delta,
}: ReviewAlignedPairProps) => {
  const pair = buildMarkedPair({
    deltaStandardText: delta?.standard?.text,
    deltaTargetText: delta?.target?.text,
    standard: standard.passages,
    target: target.passages,
  });

  return (
    <div className="@container/review-pair">
      <div className={cn("grid grid-cols-1 gap-y-3", SIDE_BY_SIDE_GRID_CLASS)}>
        <ReviewPassageSide
          emptyLabel={target.emptyLabel}
          label={target.label}
          onActivate={onShowInDocument}
          paragraphs={pair.target}
        />
        <div className="border-border border-t pt-3 @min-[40rem]/review-pair:border-t-0 @min-[40rem]/review-pair:pt-0">
          <ReviewPassageSide
            emptyLabel={standard.emptyLabel}
            label={standardLabel ?? standard.label}
            onActivate={onShowStandardPassage}
            paragraphs={pair.standard}
          />
        </div>
      </div>
    </div>
  );
};
