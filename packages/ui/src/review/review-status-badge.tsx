import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * The semantic weight of a review status, independent of the words a surface
 * uses for it. Playbook verdicts, overall risk, proposal states, suggestion
 * decisions and approval states each map their own vocabulary onto one tone,
 * so "this is fine" reads as the same green everywhere and a reviewer never
 * has to relearn a palette when moving between panels.
 */
export type ReviewStatusTone =
  | "neutral"
  | "success"
  | "warning"
  | "destructive"
  | "highlight";

export type ReviewStatusVariant = "solid" | "outline" | "strong";
export type ReviewStatusSize = "xs" | "sm";

type ReviewStatusBadgeProps = {
  tone: ReviewStatusTone;
  /** Outlined by default. `solid` adds a tonal wash for a status that has to
   *  carry more weight than its neighbours (an overall risk, an approval);
   *  `strong` fills it outright, reserved for the one state on a surface that
   *  must escalate past every other badge beside it. */
  variant?: ReviewStatusVariant;
  size?: ReviewStatusSize;
  /** Leading glyph, typically a `<ReviewSeverityDot />`. */
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** One status pill for every review surface: one radius, one padding scale,
 *  one tone vocabulary. */
export const ReviewStatusBadge = ({
  tone,
  variant = "outline",
  size = "xs",
  icon,
  className,
  children,
}: ReviewStatusBadgeProps) => (
  <span
    className={cn(
      REVIEW_STATUS_BADGE_BASE_CLASS,
      SIZE_CLASS[size],
      VARIANT_CLASS[variant],
      TONE_CLASS[variant][tone],
      className,
    )}
    data-slot="review-status-badge"
  >
    {icon}
    {children}
  </span>
);

const REVIEW_STATUS_BADGE_BASE_CLASS =
  "inline-flex shrink-0 items-center rounded-full border font-medium whitespace-nowrap";

const SIZE_CLASS = {
  xs: "gap-1 px-1.5 py-0.5 text-[11px]",
  sm: "gap-1.5 px-2 py-0.5 text-xs",
} as const satisfies Record<ReviewStatusSize, string>;

const OUTLINE_TONE_CLASS = {
  neutral: "border-border text-muted-foreground",
  success: "border-success/30 text-success",
  warning: "border-warning/30 text-warning-foreground",
  destructive: "border-destructive/30 text-destructive",
  highlight: "border-highlight text-highlight-foreground",
} as const satisfies Record<ReviewStatusTone, string>;

const SOLID_TONE_CLASS = {
  neutral: "border-transparent bg-muted text-muted-foreground",
  success: "border-transparent bg-success/12 text-success",
  warning: "border-transparent bg-warning/12 text-warning-foreground",
  destructive: "border-transparent bg-destructive/12 text-destructive",
  highlight: "border-transparent bg-highlight/50 text-highlight-foreground",
} as const satisfies Record<ReviewStatusTone, string>;

const STRONG_TONE_CLASS = {
  neutral: "border-transparent bg-muted-foreground text-background",
  success: "border-transparent bg-success text-success-foreground",
  warning: "border-transparent bg-warning text-warning-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  highlight: "border-transparent bg-highlight text-highlight-foreground",
} as const satisfies Record<ReviewStatusTone, string>;

const TONE_CLASS = {
  outline: OUTLINE_TONE_CLASS,
  solid: SOLID_TONE_CLASS,
  strong: STRONG_TONE_CLASS,
} as const satisfies Record<
  ReviewStatusVariant,
  Record<ReviewStatusTone, string>
>;

const VARIANT_CLASS = {
  outline: "",
  solid: "",
  // A filled badge paints its own ground, so a tone-coloured dot would sink
  // into it. Inside `strong` the dot takes the badge's foreground instead,
  // which keeps the contrast right for every tone without a per-call-site
  // override.
  strong: "[&_[data-slot=review-status-dot]]:bg-current",
} as const satisfies Record<ReviewStatusVariant, string>;
