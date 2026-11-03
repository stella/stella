import type { ReactNode } from "react";

import { StatuteDisplayLabel } from "@/features/statutes/components/statute-display-label";

type StatuteSignalTextProps = {
  meta: ReactNode;
  statute: Parameters<typeof StatuteDisplayLabel>[0]["statute"];
};

export const StatuteSignalText = ({
  meta,
  statute,
}: StatuteSignalTextProps) => (
  <span className="flex min-w-0 items-start gap-2">
    <span aria-hidden="true" className="size-4 shrink-0" />
    <span className="min-w-0 flex-1">
      <span className="text-foreground block text-sm font-medium">
        <StatuteDisplayLabel statute={statute} />
      </span>
      {meta !== null && (
        <span className="text-muted-foreground block truncate text-xs">
          {meta}
        </span>
      )}
    </span>
  </span>
);
