import { cn } from "../lib/utils";
import type { ReviewStatusTone } from "./review-status-badge";

/**
 * How bad a finding is, on the one scale every review surface reports against.
 * Vocabularies that stop short of five levels (a playbook's blocker/high/
 * medium/low, a suggestion's high/medium/low/unspecified) map onto this at
 * their call site rather than growing a palette of their own.
 */
export type ReviewSeverityLevel =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "none";

type ReviewSeverityDotProps = {
  level: ReviewSeverityLevel;
  className?: string | undefined;
};

/** The dot that precedes a severity label, and the one place a severity level
 *  turns into a colour. */
export const ReviewSeverityDot = ({
  level,
  className,
}: ReviewSeverityDotProps) => (
  <ReviewStatusDot className={className} tone={SEVERITY_TONE[level]} />
);

type ReviewStatusDotProps = {
  tone: ReviewStatusTone;
  className?: string | undefined;
};

/** The same dot keyed by tone, for vocabularies that are not severities
 *  (verdicts, directed impact, comparison assessments). */
export const ReviewStatusDot = ({ tone, className }: ReviewStatusDotProps) => (
  <span
    aria-hidden="true"
    className={cn(
      REVIEW_STATUS_DOT_BASE_CLASS,
      TONE_DOT_CLASS[tone],
      className,
    )}
    data-slot="review-status-dot"
  />
);

/** The tone a severity level carries, so a badge and its dot cannot disagree. */
export const reviewSeverityTone = (
  level: ReviewSeverityLevel,
): ReviewStatusTone => SEVERITY_TONE[level];

const REVIEW_STATUS_DOT_BASE_CLASS = "size-1.5 shrink-0 rounded-full";

const SEVERITY_TONE = {
  critical: "destructive",
  high: "destructive",
  medium: "warning",
  low: "neutral",
  none: "success",
} as const satisfies Record<ReviewSeverityLevel, ReviewStatusTone>;

const TONE_DOT_CLASS = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  highlight: "bg-highlight-foreground",
} as const satisfies Record<ReviewStatusTone, string>;
