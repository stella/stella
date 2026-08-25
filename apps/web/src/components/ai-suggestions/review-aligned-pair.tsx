import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { DeltaCitation } from "@/components/ai-suggestions/review-delta";
import {
  diffWords,
  type WordDiffOp,
} from "@/components/ai-suggestions/review-word-diff";

// TODO(i18n): English until the review surface is localized as a whole.
const CITATION_ARIA_LABEL = "Show in document";
const EMPTY_PASSAGE_LABEL = "No passage";

// Insertions and deletions are told apart by underline vs strike-through
// first; colour only repeats that distinction, it never carries it alone.
const WORD_DIFF_OP_CLASS = {
  equal: "",
  insert: "text-success underline decoration-1 underline-offset-2",
  delete: "text-destructive line-through",
} as const satisfies Record<WordDiffOp["type"], string>;
const wordDiffOpClass = (type: WordDiffOp["type"]): string =>
  WORD_DIFF_OP_CLASS[type];

export type ReviewAlignedPairSide = {
  label: string;
  passages: readonly DeltaCitation[];
};

export type ReviewAlignedPairProps = {
  target: ReviewAlignedPairSide;
  standard: ReviewAlignedPairSide;
  onShowInDocument?: (blockId: string) => void;
  diff?: boolean;
};

/**
 * The point of the pair is to read the two passages, not a verdict about
 * them: two quoted columns, stacked on narrow widths. When `diff` is set and
 * each side has exactly one passage, the columns collapse into a single
 * merged reading with word-level insertions and deletions marked in place.
 */
export const ReviewAlignedPair = ({
  target,
  standard,
  onShowInDocument,
  diff = false,
}: ReviewAlignedPairProps) => {
  const canDiff =
    diff && target.passages.length === 1 && standard.passages.length === 1;

  if (canDiff) {
    const targetPassage = target.passages[0];
    const standardPassage = standard.passages[0];
    return (
      <div className="space-y-1">
        <PairLegend standardLabel={standard.label} targetLabel={target.label} />
        <WordDiffPassage
          onShowInDocument={onShowInDocument}
          standardText={standardPassage.text}
          targetBlockId={targetPassage.blockId}
          targetText={targetPassage.text}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      <PassageColumn
        label={target.label}
        onActivate={onShowInDocument}
        passages={target.passages}
      />
      <PassageColumn label={standard.label} passages={standard.passages} />
    </div>
  );
};

type PairLegendProps = { targetLabel: string; standardLabel: string };

const PairLegend = ({ targetLabel, standardLabel }: PairLegendProps) => (
  <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
    <BidiText as="span">{targetLabel}</BidiText>
    <span aria-hidden="true">/</span>
    <BidiText as="span">{standardLabel}</BidiText>
  </div>
);

const passageFrameClass =
  "border-s-2 border-border bg-muted/40 block w-full rounded-e-md ps-2.5 pe-2 py-1.5 text-start";

type PassageColumnProps = {
  label: string;
  passages: readonly DeltaCitation[];
  onActivate?: (blockId: string) => void;
};

const PassageColumn = ({ label, passages, onActivate }: PassageColumnProps) => (
  <div className="min-w-0 space-y-1">
    <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
      <BidiText as="span">{label}</BidiText>
    </p>
    {passages.length === 0 ? (
      <p className="text-muted-foreground text-sm italic">
        {EMPTY_PASSAGE_LABEL}
      </p>
    ) : (
      <ul className="space-y-1">
        {passages.map((passage) => (
          <li key={passage.blockId}>
            {onActivate === undefined ? (
              <p
                className={cn(
                  passageFrameClass,
                  "font-serif text-sm leading-relaxed",
                )}
              >
                <BidiText as="span">
                  <q>{passage.text}</q>
                </BidiText>
              </p>
            ) : (
              <button
                aria-label={CITATION_ARIA_LABEL}
                className={cn(
                  passageFrameClass,
                  "hover:border-ring hover:bg-muted font-serif text-sm leading-relaxed transition-colors duration-150",
                )}
                onClick={() => onActivate(passage.blockId)}
                type="button"
              >
                <BidiText as="span">
                  <q>{passage.text}</q>
                </BidiText>
              </button>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
);

type WordDiffPassageProps = {
  targetText: string;
  standardText: string;
  targetBlockId: string;
  onShowInDocument?: (blockId: string) => void;
};

const WordDiffPassage = ({
  targetText,
  standardText,
  targetBlockId,
  onShowInDocument,
}: WordDiffPassageProps) => {
  const ops = diffWords(standardText, targetText);
  const content = (
    <BidiText as="span">
      <q>
        {ops.map((op, index) => (
          // eslint-disable-next-line react/no-array-index-key -- ops is a read-only diff recomputed fresh from the two passages on every render (whole-list replace); tokens are non-interactive with no per-item state.
          <span className={cn(wordDiffOpClass(op.type))} key={index}>
            {op.token}
          </span>
        ))}
      </q>
    </BidiText>
  );

  if (onShowInDocument === undefined) {
    return (
      <p
        className={cn(passageFrameClass, "font-serif text-sm leading-relaxed")}
      >
        {content}
      </p>
    );
  }

  return (
    <button
      aria-label={CITATION_ARIA_LABEL}
      className={cn(
        passageFrameClass,
        "hover:border-ring hover:bg-muted font-serif text-sm leading-relaxed transition-colors duration-150",
      )}
      onClick={() => onShowInDocument(targetBlockId)}
      type="button"
    >
      {content}
    </button>
  );
};
