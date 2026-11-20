import type { ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

// A company record in both phases (a pending-safe module): the loaded preview
// renders this frame with the record, its pending phase with placeholders on
// the same lines.

/** The record's column: who the company is, then what is said about it. */
export const CompanyRegistryPreviewFrame = ({
  children,
  className,
}: {
  children: ReactNode;
  /** How the loaded record scrolls; the pending one does not. */
  className?: string | undefined;
}) => <div className={cn("h-full space-y-6 p-5", className)}>{children}</div>;

/** The record before the registry has answered: name, number, address and
 *  the specification's box, each on its own line. */
export const CompanyRegistryPreviewPending = () => (
  <CompanyRegistryPreviewFrame>
    <section aria-hidden="true" className="space-y-3">
      <div className="min-w-0 space-y-1">
        <p className="text-lg font-semibold">
          <FaceLabelPending className="w-2/3" />
        </p>
        <p className="text-sm">
          <FaceLabelPending className="w-28" />
        </p>
      </div>
      <p className="text-sm leading-6">
        <FaceLabelPending className="w-1/2" />
      </p>
    </section>
    <div aria-hidden="true" className="bg-muted/40 rounded-lg p-3 shadow-sm">
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    </div>
  </CompanyRegistryPreviewFrame>
);
