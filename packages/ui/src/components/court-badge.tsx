import { cn } from "../lib/utils";

/**
 * How a court's abbreviation is drawn: solid ink for the apex, then lighter
 * treatments down the instances.
 *
 * A rank, not a status, so the scale is weight and not colour. Colour here
 * would be a second vocabulary a reader has to learn, and one that a
 * colour-blind or monochrome reader cannot read at all — the badge never
 * carries meaning on its own anyway: the court's name stands beside it.
 */
export type CourtBadgeWeight = "solid" | "tinted" | "outline" | "dashed";

type CourtBadgeProps = {
  /** The court's own abbreviation, in the language its name is in. */
  abbreviation: string;
  weight: CourtBadgeWeight;
  className?: string;
};

const COURT_BADGE_BASE_CLASS =
  // Monospaced and tracked out: these are two to four capitals read as a
  // unit, and a proportional face at this size turns ÚS and NS into blots of
  // different widths down a column.
  "inline-flex shrink-0 items-center rounded-sm border px-1 py-px font-mono text-[10px] leading-4 font-medium tracking-wide whitespace-nowrap";

const WEIGHT_CLASS = {
  solid: "border-foreground bg-foreground text-background",
  tinted: "border-transparent bg-muted text-foreground",
  outline: "border-border text-muted-foreground",
  dashed: "border-border border-dashed text-muted-foreground",
} as const satisfies Record<CourtBadgeWeight, string>;

/**
 * A court's abbreviation as a chip: `ÚS`, `NS`, `NSS`, `KS`, `SN`, `CJEU`.
 *
 * Always rendered beside the court's name, never instead of it — a reader who
 * does not know the abbreviation must lose nothing — and only where an
 * abbreviation is actually known. There is no placeholder: a court nobody
 * abbreviates gets no chip.
 */
export const CourtBadge = ({
  abbreviation,
  className,
  weight,
}: CourtBadgeProps) => (
  <span
    className={cn(COURT_BADGE_BASE_CLASS, WEIGHT_CLASS[weight], className)}
    data-slot="court-badge"
    // Latin capitals inside a name in any script, including an RTL one: the
    // isolate keeps the chip from reordering with the text around it.
    dir="ltr"
  >
    {abbreviation}
  </span>
);
