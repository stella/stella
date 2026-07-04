import type { ReactNode } from "react";

import { cn } from "@stll/ui/lib/utils";

type ComposerStatusRowProps = {
  /** Left cluster: matter picker, web-search / anonymize toggles, ... */
  start?: ReactNode | undefined;
  /** End slot, pinned to the far edge (e.g. the context meter). */
  end?: ReactNode | undefined;
  className?: string | undefined;
};

// The slim status row rendered beneath a chat composer box: a `text-xs`
// row with a start cluster and an end slot pinned to the far edge. Shared
// by every chat surface so the shell can never drift. Renders nothing when
// both slots are empty, so a surface with no per-send controls shows no row.
export const ComposerStatusRow = ({
  start,
  end,
  className,
}: ComposerStatusRowProps) => {
  if (start === undefined && end === undefined) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground mt-1.5 flex items-center justify-between gap-2 px-1 text-xs",
        className,
      )}
    >
      {start}
      {end !== undefined && <div className="ms-auto">{end}</div>}
    </div>
  );
};
