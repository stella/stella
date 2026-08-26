import { Fragment, useCallback, useState } from "react";

import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { DeltaCitation } from "@/components/ai-suggestions/review-delta";
import {
  buildMarkedPair,
  type KeyTermKind,
  type MarkedParagraph,
  type MarkedSegment,
} from "@/components/ai-suggestions/review-key-terms";
import type { ParameterDelta } from "@/components/ai-suggestions/review-term-row";

// TODO(i18n): English until the review surface is localized as a whole.
const CITATION_ARIA_LABEL = "Show in document";
const EMPTY_PASSAGE_LABEL = "No passage";
const SHOW_MORE_LABEL = "Show more";
const SHOW_LESS_LABEL = "Show less";

/**
 * Three strengths of one mark, never two competing colours. A diff run is the
 * quietest: it only says the other side words this differently. A key term
 * adds weight and a dotted rule because it is the thing being compared. The
 * delta's own phrase is the strongest, because the finding is about it.
 *
 * Nothing is struck through or coloured by direction: neither side is a
 * correction of the other, so a redline would assert something untrue.
 */
const MARK_BASE_CLASS = "rounded-[0.15rem] px-px text-inherit";
const MARK_CLASS = {
  diff: "bg-highlight/50",
  term: "bg-highlight font-medium underline decoration-dotted decoration-1 underline-offset-4",
  delta:
    "bg-highlight font-semibold underline decoration-dotted decoration-2 underline-offset-4",
} as const satisfies Record<KeyTermKind, string>;

/**
 * Roughly twelve lines at `text-sm`/`leading-relaxed` (0.875rem × 1.625 ≈
 * 1.42rem a line). Both sides collapse to the same height, so their opening
 * lines stay level however unevenly the two passages run on.
 */
const COLLAPSED_HEIGHT_CLASS = "max-h-[17rem]";

/** The width past which the card can hold two readable columns. */
const SIDE_BY_SIDE_GRID_CLASS =
  "@min-[40rem]/review-pair:grid-cols-2 @min-[40rem]/review-pair:gap-x-6";

export type ReviewAlignedPairSide = {
  label: string;
  passages: readonly DeltaCitation[];
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
 * measures; below that the standard stacks under a rule, because two columns
 * of forty characters are harder to follow than one of sixty-five.
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
        <PassageSide
          label={target.label}
          onActivate={onShowInDocument}
          paragraphs={pair.target}
        />
        <div className="border-border border-t pt-3 @min-[40rem]/review-pair:border-t-0 @min-[40rem]/review-pair:pt-0">
          <PassageSide
            label={standardLabel ?? standard.label}
            onActivate={onShowStandardPassage}
            paragraphs={pair.standard}
          />
        </div>
      </div>
    </div>
  );
};

type PassageSideProps = {
  label: string;
  paragraphs: readonly MarkedParagraph[];
  onActivate?: ((blockId: string) => void) | undefined;
};

const PassageSide = ({ label, paragraphs, onActivate }: PassageSideProps) => {
  const [expanded, setExpanded] = useState(false);
  const { contentRef, overflows } = useCollapsedOverflow();
  const hangingLabels = paragraphs.some(
    (paragraph) => paragraph.label !== null,
  );

  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        <BidiText as="span">{label}</BidiText>
      </p>
      {paragraphs.length === 0 ? (
        <p className="text-muted-foreground text-sm italic">
          {EMPTY_PASSAGE_LABEL}
        </p>
      ) : (
        <>
          <div
            className={cn(
              "max-w-[65ch] space-y-2 overflow-hidden",
              !expanded && COLLAPSED_HEIGHT_CLASS,
            )}
            ref={contentRef}
          >
            {paragraphs.map((paragraph) => (
              <PassageParagraph
                hangingLabels={hangingLabels}
                key={paragraph.blockId}
                onActivate={onActivate}
                paragraph={paragraph}
              />
            ))}
          </div>
          {overflows && (
            <button
              className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-xs font-medium"
              onClick={() => {
                setExpanded(!expanded);
              }}
              type="button"
            >
              {expanded ? SHOW_LESS_LABEL : SHOW_MORE_LABEL}
            </button>
          )}
        </>
      )}
    </div>
  );
};

/**
 * Whether the collapsed passage has more to show. Sticky once true: expanding
 * removes the height cap, so a fresh measurement would say "fits" and take
 * the toggle away mid-read.
 *
 * A callback ref rather than an effect: the measured node only appears once
 * its side has passages, and it must be measured exactly once per node
 * lifetime regardless of what re-renders the parent.
 */
const useCollapsedOverflow = () => {
  const [overflows, setOverflows] = useState(false);
  const contentRef = useCallback((node: HTMLElement | null) => {
    if (node === null) {
      return undefined;
    }
    const measure = () => {
      setOverflows(
        (previous) => previous || node.scrollHeight > node.clientHeight,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return { contentRef, overflows };
};

type PassageParagraphProps = {
  paragraph: MarkedParagraph;
  /** Whether any block on this side carries a clause number. When one does,
   *  every block reserves the same label column, so the prose keeps one edge
   *  down the passage instead of stepping in at each numbered block. */
  hangingLabels: boolean;
  onActivate?: ((blockId: string) => void) | undefined;
};

const PassageParagraph = ({
  paragraph,
  hangingLabels,
  onActivate,
}: PassageParagraphProps) => {
  const prose = (
    <BidiText as="span" className="min-w-0 flex-1">
      <MarkedText segments={paragraph.segments} />
    </BidiText>
  );
  const body = hangingLabels ? (
    <>
      <span className="text-muted-foreground w-12 shrink-0 font-medium tabular-nums">
        {paragraph.label ?? ""}
      </span>
      {prose}
    </>
  ) : (
    prose
  );
  const proseClass =
    "flex w-full items-baseline gap-2 text-start font-serif text-sm leading-relaxed text-pretty";

  if (onActivate === undefined) {
    return <p className={proseClass}>{body}</p>;
  }

  return (
    <button
      aria-label={CITATION_ARIA_LABEL}
      className={cn(
        proseClass,
        "hover:bg-muted/60 rounded-sm transition-colors duration-150",
      )}
      onClick={() => {
        onActivate(paragraph.blockId);
      }}
      type="button"
    >
      {body}
    </button>
  );
};

const MarkedText = ({ segments }: { segments: readonly MarkedSegment[] }) => (
  <>
    {segments.map((segment) =>
      segment.kind === null ? (
        <Fragment key={segment.start}>{segment.text}</Fragment>
      ) : (
        <mark
          className={cn(MARK_BASE_CLASS, MARK_CLASS[segment.kind])}
          key={segment.start}
        >
          {segment.text}
        </mark>
      ),
    )}
  </>
);
