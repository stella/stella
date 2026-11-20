import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

type DefaultPendingComponentProps = {
  className?: string | undefined;
  /**
   * Announce the loading state. Off when the caller already wraps the
   * skeleton in its own (localized) status region.
   */
  announce?: boolean | undefined;
};

/** How a pending view rendered before the intl provider mounts announces
 *  itself: one busy status region around decorative skeleton bars. */
export const PENDING_STATUS_PROPS = {
  "aria-busy": true,
  "aria-label": "Loading",
  role: "status",
} as const;

// Shared content fallback, including before the intl provider mounts. Shell
// chrome belongs to the frame owner, never to a nested loading boundary.
// It is the last resort, never a page's loading view: a route's
// `pendingComponent` is the page's own tree in a pending phase (static
// chrome real, data regions as skeletons from the loaded rows' primitives;
// the contract is in `routes/-route-pending-view.tsx`), and the
// `route-pending-component` lint rule keeps this out of route options.
export const DefaultPendingComponent = ({
  className,
  announce = true,
}: DefaultPendingComponentProps) => (
  // Announced as busy content; the skeleton bars themselves are decoration.
  <div
    {...(announce ? PENDING_STATUS_PROPS : { "aria-hidden": true })}
    className={cn(
      "flex h-full min-h-0 w-full flex-1 flex-col gap-4 p-6",
      className,
    )}
  >
    <Skeleton aria-hidden="true" className="h-7 w-1/3" />
    <Skeleton aria-hidden="true" className="h-4 w-2/3" />
    <Skeleton
      aria-hidden="true"
      className="min-h-40 w-full flex-1 rounded-xl"
    />
    <Skeleton aria-hidden="true" className="h-4 w-1/2" />
    <Skeleton aria-hidden="true" className="h-24 w-full rounded-xl" />
  </div>
);
