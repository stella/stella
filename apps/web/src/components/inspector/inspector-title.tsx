import type { ReactNode } from "react";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

type InspectorTitleProps = {
  /** True when the entity has no name; the placeholder is shown muted. */
  isEmpty: boolean;
  /** Makes the title a button that starts renaming. */
  onEdit?: (() => void) | undefined;
  children: ReactNode;
};

/** Large heading at the top of an inspector view: foreground unless empty. */
export const InspectorTitle = ({
  isEmpty,
  onEdit,
  children,
}: InspectorTitleProps) => {
  const className = cn(
    "text-base font-semibold",
    isEmpty ? "text-muted-foreground" : "text-foreground",
  );
  if (onEdit === undefined) {
    return (
      <h2 className={cn(className, "text-balance")} data-slot="inspector-title">
        {children}
      </h2>
    );
  }
  // The heading draws the editable box (hover fill, inset, ellipsis) and the
  // button runs inline inside it, so the title keeps one typographic
  // treatment and its colour, and the button's stretched hit area still
  // covers the whole row. Spaces are kept as typed (`whitespace-pre`).
  return (
    <h2
      className={cn(
        className,
        "hover:bg-accent relative -mx-1 my-0 overflow-hidden rounded-sm px-1 text-start text-ellipsis whitespace-pre",
      )}
      data-slot="inspector-title"
    >
      <Button
        className="inline after:absolute after:inset-0"
        onClick={onEdit}
        variant="plain"
      >
        {children}
      </Button>
    </h2>
  );
};
