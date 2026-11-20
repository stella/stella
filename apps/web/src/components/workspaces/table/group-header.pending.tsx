import type { ReactNode } from "react";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronDownIcon, ChevronRightIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

/*
 * A grouped table's section header, in the pieces its loading face shares
 * with the live header: the opaque band, the toggle's box and the line that
 * carries the chevron, the option's colour, the label and the count. The
 * live header (`group-header.tsx`) puts its toggle button between the band
 * and the line; the face puts an inert box of the same classes there.
 */

/** The band every section header draws, sticky above its rows. */
export const TableGroupHeaderBand = ({
  children,
  empty,
}: {
  children: ReactNode;
  empty: boolean;
}) => (
  <div
    className={cn(
      "sticky top-0 z-40 flex items-center gap-2 border-b pe-3",
      // An empty category recedes into the background, surfacing on hover
      // so it stays scannable without competing with populated groups.
      empty && "opacity-60 transition-opacity duration-200 hover:opacity-100",
    )}
    // Opaque header so scrolled rows don't show through. `bg-muted` and
    // `bg-secondary` are both translucent (~4% over transparent) in this theme,
    // so we composite that 4% tint over the opaque background by hand.
    style={{
      backgroundColor:
        "color-mix(in oklab, var(--foreground) 4%, var(--background))",
    }}
  >
    {children}
  </div>
);

/** The header's line: chevron, option colour, label and count. */
export const TableGroupHeaderLine = ({
  collapsed,
  colorIcon,
  tallySlot,
  empty,
  label,
}: {
  collapsed: boolean;
  colorIcon: ReactNode;
  tallySlot: ReactNode;
  empty: boolean;
  label: ReactNode;
}) => {
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-1 items-center py-1.5",
        !empty && "hover:bg-foreground/[0.04]",
      )}
    >
      {/* The label stays pinned at the left while the band scrolls
        horizontally with the columns. The full-width `bg-muted` band lives
        on the row wrapper, so the pinned label adds no second layer (a
        second translucent `bg-muted` here darkened only the label's span,
        reading as a partial band that stopped mid-row). */}
      <span className="sticky start-0 flex items-center gap-2 ps-3">
        {empty ? (
          <span aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <DirectionalIcon
            icon={ChevronIcon}
            flip={collapsed}
            className="text-muted-foreground size-3.5 shrink-0"
          />
        )}
        {colorIcon}
        <span className="text-foreground text-sm font-medium">{label}</span>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {tallySlot}
        </span>
      </span>
    </span>
  );
};

/** The count's place while the section counts load. */
export const TableGroupCountPending = () => <Skeleton className="h-3 w-10" />;

/**
 * A section header before the counts arrive, as the live header draws it
 * then: expanded, its count a bar. `color` is the option's resolved colour,
 * drawn as the live header's swatch.
 */
export const TableGroupHeaderPending = ({
  color,
  label,
}: {
  color: string | undefined;
  label: ReactNode;
}) => (
  <TableGroupHeaderBand empty={false}>
    {/* The toggle button's box, inert: a plain button as the live header
      places it (`flex min-w-0 flex-1`, written on the button itself, where
      the design-system rules read a component's classes). */}
    <div className="relative flex max-w-full min-w-0 flex-1 text-start">
      <TableGroupHeaderLine
        collapsed={false}
        colorIcon={
          color === undefined ? null : (
            <span
              className="block size-3.5 shrink-0 rounded-sm"
              style={{ backgroundColor: color }}
            />
          )
        }
        tallySlot={<TableGroupCountPending />}
        empty={false}
        label={label}
      />
    </div>
  </TableGroupHeaderBand>
);
