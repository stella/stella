import type * as React from "react";

import { cn } from "../lib/utils";

// A query container is size-contained, so its content no longer sizes it: in
// a content-sized host (a popover, a `w-max` box) the sheet measured 0px wide
// and every value wrapped one letter per line. It claims one column's minimum
// instead; `min-w-0` still lets a narrower host shrink it.
const DetailsGrid = ({ className, ...props }: React.ComponentProps<"dl">) => (
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
);

type DetailsItemProps = React.ComponentProps<"div"> & {
  label: React.ReactNode;
  span?: "wide";
};

const DetailsItem = ({
  label,
  children,
  span,
  className,
  ...props
}: DetailsItemProps) => (
  <div
    className={cn(
      "grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-x-4 text-xs",
      span === "wide" && "col-span-full",
      className,
    )}
    data-slot="details-item"
    {...props}
  >
    <dt className="text-foreground-disabled min-w-0 font-medium tracking-wide wrap-anywhere uppercase">
      {label}
    </dt>
    <dd className="text-foreground-strong-muted min-w-0 wrap-anywhere">
      {children}
    </dd>
  </div>
);

export { DetailsGrid, DetailsItem };
