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
 * - `auto`: vertical in a narrow container (a phone, a side panel under
 *   24rem) and horizontal once there is room, measured on the grid's own
 *   container rather than the viewport.
 */
type DetailsOrientation = "horizontal" | "vertical" | "auto";

/**
 * How wide the label column of a horizontal grid is. `auto` sizes it to the
 * longest label (the list default); `sm`, `md` (the sheet default, 7rem) and
 * `lg` fix it, so several grids on one page line their values up.
 */
type DetailsLabelWidth = "auto" | "sm" | "md" | "lg";

type DetailsShape = {
  labelWidth: DetailsLabelWidth;
  orientation: DetailsOrientation;
  variant: DetailsVariant;
};

const DetailsShapeContext = createContext<DetailsShape>({
  labelWidth: "md",
  orientation: "horizontal",
  variant: "sheet",
});

const LIST_CLASS_NAME = {
  auto: "flex min-w-0 flex-col gap-2 text-sm @min-[24rem]:grid @min-[24rem]:items-center @min-[24rem]:gap-x-4 @min-[24rem]:gap-y-1",
  horizontal: "grid items-center gap-x-4 gap-y-1 text-sm",
  vertical: "flex min-w-0 flex-col gap-2 text-sm",
} as const satisfies Record<DetailsOrientation, string>;

/** The list's label and value tracks, per label width. */
const LIST_COLUMNS_CLASS_NAME = {
  auto: "grid-cols-[auto_minmax(0,1fr)]",
  lg: "grid-cols-[10rem_minmax(0,1fr)]",
  md: "grid-cols-[7rem_minmax(0,1fr)]",
  sm: "grid-cols-[5rem_minmax(0,1fr)]",
} as const satisfies Record<DetailsLabelWidth, string>;

/** The same tracks, applied only once an `auto` list turns horizontal. */
const LIST_AUTO_COLUMNS_CLASS_NAME = {
  auto: "@min-[24rem]:grid-cols-[auto_minmax(0,1fr)]",
  lg: "@min-[24rem]:grid-cols-[10rem_minmax(0,1fr)]",
  md: "@min-[24rem]:grid-cols-[7rem_minmax(0,1fr)]",
  sm: "@min-[24rem]:grid-cols-[5rem_minmax(0,1fr)]",
} as const satisfies Record<DetailsLabelWidth, string>;

/** A sheet pair's label and value tracks; `auto` keeps the 7rem default. */
const SHEET_ITEM_COLUMNS_CLASS_NAME = {
  auto: "grid-cols-[minmax(0,7rem)_minmax(0,1fr)]",
  lg: "grid-cols-[minmax(0,10rem)_minmax(0,1fr)]",
  md: "grid-cols-[minmax(0,7rem)_minmax(0,1fr)]",
  sm: "grid-cols-[minmax(0,5rem)_minmax(0,1fr)]",
} as const satisfies Record<DetailsLabelWidth, string>;

const SHEET_AUTO_ITEM_COLUMNS_CLASS_NAME = {
  auto: "@min-[20rem]:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]",
  lg: "@min-[20rem]:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]",
  md: "@min-[20rem]:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]",
  sm: "@min-[20rem]:grid-cols-[minmax(0,5rem)_minmax(0,1fr)]",
} as const satisfies Record<DetailsLabelWidth, string>;

const ITEM_CLASS_NAME = {
  list: {
    auto: "flex min-w-0 flex-col gap-0.5 @min-[24rem]:col-span-full @min-[24rem]:grid @min-[24rem]:grid-cols-subgrid @min-[24rem]:items-center",
    // A subgrid row, so every label shares the list's one label column.
    horizontal: "col-span-full grid grid-cols-subgrid items-center",
    vertical: "flex min-w-0 flex-col gap-2",
  },
  sheet: {
    auto: "flex min-w-0 flex-col gap-1 text-xs @min-[20rem]:grid @min-[20rem]:items-start @min-[20rem]:gap-x-4",
    horizontal: "grid min-w-0 items-start gap-x-4 text-xs",
    vertical: "flex min-w-0 flex-col gap-1 text-xs",
  },
} as const satisfies Record<DetailsVariant, Record<DetailsOrientation, string>>;

const LABEL_CLASS_NAME = {
  list: {
    auto: "text-muted-foreground min-w-0",
    horizontal: "text-muted-foreground min-w-0",
    vertical: "font-medium",
  },
  sheet: {
    auto: "text-foreground-disabled min-w-0 font-medium tracking-wide wrap-anywhere uppercase",
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
  labelWidth?: DetailsLabelWidth;
  orientation?: DetailsOrientation;
  variant?: DetailsVariant;
};

// A query container is size-contained, so its content no longer sizes it: in
// a content-sized host (a popover, a `w-max` box) the sheet measured 0px wide
// and every value wrapped one letter per line. It claims one column's minimum
// instead; `min-w-0` still lets a narrower host shrink it.
const DetailsGrid = ({
  className,
  labelWidth,
  orientation = "horizontal",
  variant = "sheet",
  ...props
}: DetailsGridProps) => {
  const shape = {
    labelWidth: labelWidth ?? (variant === "list" ? "auto" : "md"),
    orientation,
    variant,
  };
  if (variant === "list") {
    const list = (
      <dl
        className={cn(
          LIST_CLASS_NAME[orientation],
          orientation === "horizontal" &&
            LIST_COLUMNS_CLASS_NAME[shape.labelWidth],
          orientation === "auto" &&
            LIST_AUTO_COLUMNS_CLASS_NAME[shape.labelWidth],
          className,
        )}
        data-orientation={orientation}
        data-slot="details-grid"
        data-variant={variant}
        {...props}
      />
    );
    return (
      <DetailsShapeContext.Provider value={shape}>
        {orientation === "auto" ? (
          // `auto` measures the list's own container, not the viewport.
          <div
            className="@container min-w-0"
            data-slot="details-grid-container"
          >
            {list}
          </div>
        ) : (
          list
        )}
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
  const { labelWidth, orientation, variant } = useContext(DetailsShapeContext);
  return (
    <div
      className={cn(
        ITEM_CLASS_NAME[variant][orientation],
        variant === "sheet" &&
          orientation === "horizontal" &&
          SHEET_ITEM_COLUMNS_CLASS_NAME[labelWidth],
        variant === "sheet" &&
          orientation === "auto" &&
          SHEET_AUTO_ITEM_COLUMNS_CLASS_NAME[labelWidth],
        variant === "sheet" && span === "wide" && "col-span-full",
        className,
      )}
      data-slot="details-item"
      {...props}
    >
      <dt className={LABEL_CLASS_NAME[variant][orientation]}>{label}</dt>
      <dd className={VALUE_CLASS_NAME[variant]}>
        {isEmptyValue(children) ? (
          // A fact with no value still holds its row, so the reader sees it
          // was looked for; the dash is drawn, not read.
          <span className="text-foreground-disabled" data-slot="details-empty">
            —
          </span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
};

/** No value to show: nothing, or only whitespace. */
function isEmptyValue(value: React.ReactNode): boolean {
  if (value === null || value === undefined || value === false) {
    return true;
  }
  return typeof value === "string" && value.trim() === "";
}

export {
  DetailsGrid,
  DetailsItem,
  type DetailsLabelWidth,
  type DetailsOrientation,
  type DetailsVariant,
};
