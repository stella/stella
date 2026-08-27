/**
 * One column of quoted passages, and the only place the review surface draws
 * them.
 *
 * The results card's "This document" / "Standard" columns, the confirm step's
 * proposed positions and the playbook editor's reference standard all render
 * through this component, so a passage looks the same wherever a position
 * appears: one type scale, the clause number hanging in the margin, the same
 * marks, the same collapse.
 */

import { Fragment, useCallback, useState } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import {
  buildMarkedSide,
  type KeyTermKind,
  type MarkedParagraph,
  type MarkedSegment,
  type PassageInput,
} from "@/components/ai-suggestions/review-key-terms";

/**
 * Three strengths of one mark, never two competing colours. A diff run is the
 * quietest: it only says the other side words this differently. A key term
 * adds weight and a dotted rule because it is the thing being compared. The
 * delta's own phrase is the strongest, because the finding is about it.
 *
 * Nothing is struck through or coloured by direction: neither side is a
 * correction of the other, so a redline would assert something untrue. No mark
 * changes the type size — the passage stays one measure of one scale.
 */
const MARK_BASE_CLASS = "rounded-[0.15rem] px-px text-inherit";
const MARK_CLASS = {
  diff: "bg-highlight/50",
  term: "bg-highlight font-medium underline decoration-dotted decoration-1 underline-offset-4",
  delta:
    "bg-highlight font-semibold underline decoration-dotted decoration-2 underline-offset-4",
} as const satisfies Record<KeyTermKind, string>;

/** The one section label in the review surface: every column heading, every
 *  block heading, one size. */
export const REVIEW_SECTION_LABEL_CLASS =
  "text-muted-foreground text-xs tracking-wide uppercase";

/** A clause number in the hanging margin, or any other numeric caption beside
 *  a passage. */
export const REVIEW_CLAUSE_LABEL_CLASS =
  "text-muted-foreground text-xs tabular-nums";

/** The passage measure: one scale, one leading, everywhere a passage renders.
 *  The pane's own width is the measure, so nothing caps it at a column. */
const PASSAGE_PROSE_CLASS =
  "flex w-full items-baseline gap-2 text-start text-sm leading-6 text-pretty";

/**
 * How much of a passage a collapsed column shows.
 *
 * `full` is the comparison's twelve lines: both sides of a pair collapse to
 * the same height, so their opening lines stay level however unevenly the two
 * passages run on. `compact` is the two-and-a-bit a position gets in a list of
 * positions, where the quote is evidence for the issue rather than the thing
 * being read.
 */
export const PASSAGE_COLLAPSE = {
  full: "full",
  compact: "compact",
} as const;

export type PassageCollapse =
  (typeof PASSAGE_COLLAPSE)[keyof typeof PASSAGE_COLLAPSE];

/** Lines at `text-sm`/`leading-6` (1.5rem a line). */
const COLLAPSED_HEIGHT_CLASS = {
  full: "max-h-[18rem]",
  compact: "max-h-[3rem]",
} as const satisfies Record<PassageCollapse, string>;

export type ReviewPassageSideProps = {
  label: string;
  paragraphs: readonly MarkedParagraph[];
  /** How tall the collapsed column is. Defaults to the comparison's height. */
  collapse?: PassageCollapse | undefined;
  /** What the expander reads as when there is more to show. Defaults to
   *  "Show more"; a list of positions names the quantity instead. */
  expandLabel?: string | undefined;
  onActivate?: ((blockId: string) => void) | undefined;
};

export const ReviewPassageSide = ({
  label,
  paragraphs,
  collapse = PASSAGE_COLLAPSE.full,
  expandLabel,
  onActivate,
}: ReviewPassageSideProps) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const { contentRef, overflows } = useCollapsedOverflow();
  const hangingLabels = paragraphs.some(
    (paragraph) => paragraph.label !== null,
  );

  return (
    <div className="min-w-0 space-y-1.5">
      <p className={REVIEW_SECTION_LABEL_CLASS}>
        <BidiText as="span">{label}</BidiText>
      </p>
      {paragraphs.length === 0 ? (
        <p className="text-muted-foreground text-sm leading-6 italic">
          {t("inspector.review.noPassage")}
        </p>
      ) : (
        <>
          <div
            className={cn(
              "space-y-2 overflow-hidden",
              !expanded && COLLAPSED_HEIGHT_CLASS[collapse],
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
              {expanded
                ? t("common.showLess")
                : (expandLabel ?? t("common.showMore"))}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export type ReviewStandardPassagesProps = {
  label: string;
  passages: readonly PassageInput[];
  collapse?: PassageCollapse | undefined;
  expandLabel?: string | undefined;
  onActivate?: ((blockId: string) => void) | undefined;
};

/**
 * The "Standard" column with nothing to compare it against: a playbook's
 * pinned reference passages, marked for key terms only. Same component, same
 * measure, same collapse as the column a results card draws.
 */
export const ReviewStandardPassages = ({
  label,
  passages,
  collapse,
  expandLabel,
  onActivate,
}: ReviewStandardPassagesProps) => (
  <ReviewPassageSide
    collapse={collapse}
    expandLabel={expandLabel}
    label={label}
    onActivate={onActivate}
    paragraphs={buildMarkedSide(passages)}
  />
);

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
  const t = useTranslations();
  const prose = (
    <BidiText as="span" className="min-w-0 flex-1">
      <MarkedText segments={paragraph.segments} />
    </BidiText>
  );
  const body = hangingLabels ? (
    <>
      <span className={cn(REVIEW_CLAUSE_LABEL_CLASS, "w-12 shrink-0")}>
        {paragraph.label ?? ""}
      </span>
      {prose}
    </>
  ) : (
    prose
  );

  if (onActivate === undefined) {
    return <p className={PASSAGE_PROSE_CLASS}>{body}</p>;
  }

  return (
    <button
      aria-label={t("inspector.review.showInDocument")}
      className={cn(
        PASSAGE_PROSE_CLASS,
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
