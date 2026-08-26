/**
 * The clause map: one thin band under the results header showing where in the
 * document the run's findings actually fall.
 *
 * It answers the question a list cannot — "is this deal broken all over, or
 * only in the indemnity?" — and it answers it in the document's own order,
 * not the list's severity order. Segments are clauses, ticks are findings,
 * opacity is how many of them landed on one clause. Severity gets exactly one
 * accent, for the findings that stop a deal; everything else is neutral ink,
 * because a strip of five colours is a legend, not a map.
 *
 * Pure CSS: no chart library, no canvas, no measurement. The strip is two
 * lists turned into percentages, which is a job for `buildDealStrip`.
 */

import type { FolioAIBlock } from "@stll/folio-react";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { ReviewSeverity } from "@/components/ai-suggestions/document-review-queries";
import { buildDealStrip } from "@/components/ai-suggestions/review-deal-strip.logic";
import type {
  DealStripBlock,
  DealStripFinding,
  DealStripSegment,
} from "@/components/ai-suggestions/review-deal-strip.logic";
import { isDealBreakingSeverity } from "@/components/ai-suggestions/review-verdict";
import Tooltip from "@/components/tooltip";
import { useFormatter } from "@/i18n/formatting-context";

// TODO(i18n): English until the review surface is localized as a whole.
const DEAL_STRIP_LABEL = "Where the findings sit in the document";
const DEAL_STRIP_FINDING_COUNT_LABEL = (count: string): string =>
  `${count} flagged`;
const DEAL_STRIP_MORE_LABEL = (count: string): string => `+${count} more`;

/** How many titles a hover can carry before it stops being a hint. */
const TOOLTIP_TITLE_LIMIT = 4;

/** The faintest a clause carrying findings is drawn, and how much darker the
 *  busiest one gets. Opacity carries density; nothing else does. */
const DENSITY_FLOOR = 0.14;
const DENSITY_RANGE = 0.4;

const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

/** The painted band: 10px inside a 36px target, so the strip stays thin
 *  without dropping below a usable hit area. */
const BAND_CLASS = "absolute end-px start-px top-[13px] h-2.5 rounded-[3px]";

export type ReviewDealStripTarget = {
  blockId: string;
  /** The finding to open in the list, or `null` when the reader clicked a
   *  clause the run flagged nothing in. */
  findingId: string | null;
};

type ReviewDealStripProps = {
  /** The reviewed document's blocks, in document order. */
  blocks: readonly FolioAIBlock[];
  findings: readonly ReviewDealStripFinding[];
  onSelect: (target: ReviewDealStripTarget) => void;
};

export type ReviewDealStripFinding = {
  id: string;
  title: string;
  blockId: string | null;
  severity: ReviewSeverity;
};

const toStripBlock = (block: FolioAIBlock): DealStripBlock => ({
  id: block.id,
  headingLevel: block.headingLevel ?? null,
  displayLabel: block.displayLabel ?? null,
  text: block.text,
});

const toStripFinding = (finding: ReviewDealStripFinding): DealStripFinding => ({
  id: finding.id,
  title: finding.title,
  blockId: finding.blockId,
  accent: isDealBreakingSeverity(finding.severity),
});

export const ReviewDealStrip = ({
  blocks,
  findings,
  onSelect,
}: ReviewDealStripProps) => {
  const { segments } = buildDealStrip({
    blocks: blocks.map(toStripBlock),
    findings: findings.map(toStripFinding),
  });
  // Nothing to map: the editor has not handed over the document yet, so the
  // strip would be a bar with no meaning rather than an empty one.
  if (segments.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={DEAL_STRIP_LABEL}
      className="relative mb-2 h-9 w-full"
      role="group"
    >
      <div
        aria-hidden
        className="bg-muted absolute start-0 end-0 top-[13px] h-2.5 rounded-full"
      />
      {/* Segments first, ticks over them: a tick has to stay legible inside a
          clause dark enough to read as crowded. */}
      {segments.map((segment) => (
        <DealStripSegmentButton
          key={segment.key}
          onSelect={onSelect}
          segment={segment}
        />
      ))}
      {segments.flatMap((segment) =>
        segment.marks.map((mark) => (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-[9px] h-[18px] w-0.5 rounded-full",
              mark.accent ? "bg-destructive" : "bg-foreground",
            )}
            key={mark.findingId}
            style={{ insetInlineStart: percent(mark.offset) }}
          />
        )),
      )}
    </div>
  );
};

/**
 * One clause. The button spans the strip's full height so the target stays
 * reachable while the painted band stays 10px, and it carries the clause even
 * when the run flagged nothing there — a reader pointing at clause 8 wants
 * clause 8, findings or no findings.
 */
const DealStripSegmentButton = ({
  segment,
  onSelect,
}: {
  segment: DealStripSegment;
  onSelect: (target: ReviewDealStripTarget) => void;
}) => {
  const format = useFormatter();
  // The finding that stops the deal is the one the clause is about; failing
  // that, the first one in document order.
  const lead = segment.marks.find((mark) => mark.accent) ?? segment.marks.at(0);
  const flagged = segment.marks.length;

  return (
    <Tooltip
      className="max-w-64 text-wrap"
      content={
        <span className="flex flex-col gap-0.5">
          <BidiText as="span" className="font-medium">
            {segment.label}
          </BidiText>
          {flagged > 0 && (
            <span className="tabular-nums opacity-70">
              {DEAL_STRIP_FINDING_COUNT_LABEL(format.number(flagged))}
            </span>
          )}
          {segment.marks.slice(0, TOOLTIP_TITLE_LIMIT).map((mark) => (
            <BidiText as="span" key={mark.findingId}>
              {mark.title}
            </BidiText>
          ))}
          {flagged > TOOLTIP_TITLE_LIMIT && (
            <span className="tabular-nums opacity-70">
              {DEAL_STRIP_MORE_LABEL(
                format.number(flagged - TOOLTIP_TITLE_LIMIT),
              )}
            </span>
          )}
        </span>
      }
      render={
        <button
          aria-label={segment.label}
          className="group focus-visible:ring-ring absolute top-0 bottom-0 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
          onClick={() =>
            onSelect({
              blockId: lead?.blockId ?? segment.key,
              findingId: lead?.findingId ?? null,
            })
          }
          style={{
            insetInlineStart: percent(segment.start),
            width: percent(segment.end - segment.start),
          }}
          type="button"
        />
      }
    >
      {/* Two layers rather than one: the hover wash is a class so it can be
          interrupted mid-transition, and the density fill is an inline opacity
          because it is data, not a state. */}
      <span
        aria-hidden
        className={cn(
          BAND_CLASS,
          "bg-foreground opacity-0 transition-opacity group-hover:opacity-10",
        )}
      />
      <span
        aria-hidden
        className={cn(BAND_CLASS, "bg-foreground")}
        style={{
          opacity:
            flagged === 0 ? 0 : DENSITY_FLOOR + DENSITY_RANGE * segment.density,
        }}
      />
    </Tooltip>
  );
};
