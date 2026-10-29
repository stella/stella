import { createContext, useContext } from "react";
import type * as React from "react";

import { cn } from "../lib/utils";

/**
 * - `sheet`: a fact sheet; small uppercase labels, up to three pairs per row
 *   as the container widens.
 * - `list`: one pair per row in body type with a muted label, for a short
 *   list inside a card or dialog (who is signed in, which organization).
 */
type DetailsVariant = "sheet" | "list";

/**
 * - `horizontal`: each label beside its value. In a `list`, every label
 *   shares one column sized to the longest.
 * - `vertical`: each label above its value, for values too long to share a
 *   row (a server address, a list of origins).
 */
type DetailsOrientation = "horizontal" | "vertical";

type DetailsShape = {
  orientation: DetailsOrientation;
  variant: DetailsVariant;
};

const DetailsShapeContext = createContext<DetailsShape>({
  orientation: "horizontal",
  variant: "sheet",
});

const LIST_CLASS_NAME = {
  horizontal:
    "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm",
  vertical: "flex min-w-0 flex-col gap-2 text-sm",
} as const satisfies Record<DetailsOrientation, string>;

const ITEM_CLASS_NAME = {
  list: {
    // A subgrid row, so every label shares the list's one label column.
    horizontal: "col-span-full grid grid-cols-subgrid items-center",
    vertical: "flex min-w-0 flex-col gap-2",
  },
  sheet: {
    horizontal:
      "grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-x-4 text-xs",
    vertical: "flex min-w-0 flex-col gap-1 text-xs",
  },
} as const satisfies Record<DetailsVariant, Record<DetailsOrientation, string>>;

const LABEL_CLASS_NAME = {
  list: {
    horizontal: "text-muted-foreground min-w-0",
    vertical: "font-medium",
  },
  sheet: {
    horizontal:
      "text-foreground-disabled min-w-0 font-medium tracking-wide wrap-anywhere uppercase",
    vertical:
      "text-foreground-disabled min-w-0 font-medium tracking-wide wrap-anywhere uppercase",
  },
} as const satisfies Record<DetailsVariant, Record<DetailsOrientation, string>>;

const VALUE_CLASS_NAME = {
  list: "min-w-0",
  sheet: "text-foreground-strong-muted min-w-0 wrap-anywhere",
} as const satisfies Record<DetailsVariant, string>;

type DetailsGridProps = React.ComponentProps<"dl"> & {
  orientation?: DetailsOrientation;
  variant?: DetailsVariant;
};

// A query container is size-contained, so its content no longer sizes it: in
// a content-sized host (a popover, a `w-max` box) the sheet measured 0px wide
// and every value wrapped one letter per line. It claims one column's minimum
// instead; `min-w-0` still lets a narrower host shrink it.
const DetailsGrid = ({
  className,
  orientation = "horizontal",
  variant = "sheet",
  ...props
}: DetailsGridProps) => {
  const shape = { orientation, variant };
  if (variant === "list") {
    return (
      <DetailsShapeContext.Provider value={shape}>
        <dl
          className={cn(LIST_CLASS_NAME[orientation], className)}
          data-orientation={orientation}
          data-slot="details-grid"
          data-variant={variant}
          {...props}
        />
      </DetailsShapeContext.Provider>
    );
  }
  return (
    <DetailsShapeContext.Provider value={shape}>
      <div
        className="@container min-w-0 [contain-intrinsic-inline-size:20rem]"
        data-slot="details-grid-container"
      >
        <dl
          className={cn(
            "grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-2 font-sans @min-[64rem]:grid-cols-3",
            className,
          )}
          data-slot="details-grid"
          {...props}
        />
      </div>
    </DetailsShapeContext.Provider>
  );
};

type DetailsItemProps = React.ComponentProps<"div"> & {
  label: React.ReactNode;
  /** `wide` spans every pair column of a `sheet`. */
  span?: "wide";
};

const DetailsItem = ({
  label,
  children,
  span,
  className,
  ...props
}: DetailsItemProps) => {
  const { orientation, variant } = useContext(DetailsShapeContext);
  return (
    <div
      className={cn(
        ITEM_CLASS_NAME[variant][orientation],
        variant === "sheet" && span === "wide" && "col-span-full",
        className,
      )}
      data-slot="details-item"
      {...props}
    >
      <dt className={LABEL_CLASS_NAME[variant][orientation]}>{label}</dt>
      <dd className={VALUE_CLASS_NAME[variant]}>{children}</dd>
    </div>
  );
};

export {
  DetailsGrid,
  DetailsItem,
  type DetailsOrientation,
  type DetailsVariant,
};
