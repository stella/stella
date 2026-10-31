import type { ReactNode } from "react";

import { TruncatedText } from "@stll/ui/truncated-text";
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
  return (
    <h2 className="m-0" data-slot="inspector-title">
      <button
        className={cn(
          className,
          "hover:bg-accent -mx-1 w-full rounded-sm px-1 text-start",
        )}
        onClick={onEdit}
        type="button"
      >
        <TruncatedText className="whitespace-pre">{children}</TruncatedText>
      </button>
    </h2>
  );
};
