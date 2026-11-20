import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";

/** The fixed horizontal term list, independent of layout context. */
export const DetailsListFace = ({
  className,
  ...props
}: ComponentProps<"dl">) => (
  <dl
    className={cn(
      "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm",
      className,
    )}
    data-orientation="horizontal"
    data-slot="details-grid"
    data-variant="list"
    {...props}
  />
);

/** The subgrid row aligns each label with the other labels in its list. */
export const DetailsListItemFace = ({
  label,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { label: ReactNode }) => (
  <div
    className={cn(
      "col-span-full grid grid-cols-subgrid items-center",
      className,
    )}
    data-slot="details-item"
    {...props}
  >
    <dt className="text-muted-foreground min-w-0">{label}</dt>
    <dd className="min-w-0 wrap-anywhere">{children}</dd>
  </div>
);
