/**
 * The one header row a position gets, wherever it appears: the results card in
 * the review facet, the confirm step's quick row, and the playbook editor's
 * position card.
 *
 * The results card is the reference design; the editors fill the same slots
 * with their controls rather than laying out a row of their own. The root is a
 * `span` so the results card can put the whole row inside its expand button
 * while the editors put inputs and switches in the same slots.
 */

import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { REVIEW_CLAUSE_LABEL_CLASS } from "@/components/ai-suggestions/review-passage-side";
import type { ReferenceStandard } from "@/lib/knowledge/playbook-types";

export type PositionTermKind = ReferenceStandard["termKind"];

// TODO(i18n): English until the review surface is localized as a whole.
export const TERM_KIND_LABEL = {
  parameter: "Parameter",
  enumeration: "Enumeration",
  presence: "Presence",
  language: "Language",
} as const satisfies Record<PositionTermKind, string>;

/** Secondary words in the header row: the term kind, the judgment, a badge. */
export const POSITION_HEADER_META_CLASS =
  "text-muted-foreground shrink-0 text-xs";

export type PositionHeaderProps = {
  /** Sits before the ordinal: the drag grip, where a surface has one. */
  leading?: ReactNode;
  /** The position's place in the list, when the surface numbers its rows. */
  index?: number | undefined;
  /** The issue: read-only text in the results, an input in the editors. */
  title: ReactNode;
  /** What kind of term the position compares, when the standard says. */
  termKind?: PositionTermKind | null | undefined;
  /** The right-aligned muted slot: the finding's judgment in the results, the
   *  severity chip and badges in the editors. */
  label?: ReactNode;
  /** Controls at the end of the row (switch, menus, expand). */
  actions?: ReactNode;
  className?: string | undefined;
};

export const PositionHeader = ({
  leading,
  index,
  title,
  termKind,
  label,
  actions,
  className,
}: PositionHeaderProps) => (
  <span
    className={cn(
      "flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-start",
      className,
    )}
  >
    {leading}
    {index !== undefined && (
      <span className={cn(REVIEW_CLAUSE_LABEL_CLASS, "shrink-0")}>
        {String(index + 1).padStart(2, "0")}
      </span>
    )}
    <span className="min-w-0 flex-1 text-sm leading-6">{title}</span>
    {termKind !== undefined && termKind !== null && (
      <span className={POSITION_HEADER_META_CLASS}>
        {TERM_KIND_LABEL[termKind]}
      </span>
    )}
    {label}
    {actions}
  </span>
);
