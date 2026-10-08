import { cn } from "../lib/utils";

/**
 * How a court's abbreviation is drawn: a firm edge for the apex, then lighter
 * treatments down the instances.
 *
 * A rank, not a status, so the scale is weight and not colour. Colour here
 * would be a second vocabulary a reader has to learn, and one that a
 * colour-blind or monochrome reader cannot read at all — the badge never
 * carries meaning on its own anyway: the court's name stands beside it.
 */
export type CourtBadgeWeight = "solid" | "tinted" | "outline" | "dashed";

/**
 * `default` stands on its own beside a court's name; `inline` sits inside a
 * line of small text (a list row's meta line) without making it taller.
 */
export type CourtBadgeSize = "default" | "inline";

type CourtBadgeProps = {
  /** The court's own abbreviation, in the language its name is in. */
  abbreviation: string;
  weight: CourtBadgeWeight;
  size?: CourtBadgeSize;
  className?: string;
};

const COURT_BADGE_BASE_CLASS =
  // Monospaced and tracked out: these are two to four capitals read as a
  // unit, and a proportional face at this size turns ÚS and NS into blots of
  // different widths down a column.
  "inline-flex shrink-0 items-center rounded-sm border font-mono font-semibold tracking-wide whitespace-nowrap";

/**
 * The line box runs a third taller than the type, because these capitals
 * carry diacritics (Ú, Ř, Š) whose ink rises above cap height; a tighter box
 * sets the acute against the pill's border. `inline` keeps that ratio at a
 * smaller size and drops the padding, so the chip fits a 16px text line.
 */
const SIZE_CLASS = {
  default: "px-1 py-0.5 text-xs leading-4",
  inline: "px-0.5 text-3xs leading-3.5",
} as const satisfies Record<CourtBadgeSize, string>;

/**
 * Every weight keeps a border, because `--muted` is a 4% tint: a borderless
 * tinted chip on a sidebar or a muted row is a pill whose edge nobody can
 * find. The lighter weights write their text in `foreground-strong-muted`
 * rather than `muted-foreground`: two capitals are not a paragraph a reader
 * can infer from context, so they hold body-text contrast in both themes.
 *
 * Every weight also writes its text in a foreground token on a tint, never
 * inverted on a fill. The apex is separated by the strength of its edge, not
 * by a block of ink: an ink block is the one treatment whose legibility
 * depends on `text-background` surviving intact, and it reads as a filled
 * square among chips whose surfaces are 4% tints — the two capitals inside it
 * carry the whole fact, with no contrast to spare if anything composites them.
 * Weight, applied to the border, says the same thing and cannot fail that way.
 */
const WEIGHT_CLASS = {
  solid: "border-foreground bg-muted text-foreground",
  tinted: "border-border bg-muted text-foreground",
  outline: "border-border text-foreground-strong-muted",
  dashed: "border-border border-dashed text-foreground-strong-muted",
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
  size = "default",
  weight,
}: CourtBadgeProps) => (
  <span
    className={cn(
      COURT_BADGE_BASE_CLASS,
      SIZE_CLASS[size],
      WEIGHT_CLASS[weight],
      className,
    )}
    data-slot="court-badge"
    // Latin capitals inside a name in any script, including an RTL one: the
    // isolate keeps the chip from reordering with the text around it.
    dir="ltr"
  >
    {abbreviation}
  </span>
);
