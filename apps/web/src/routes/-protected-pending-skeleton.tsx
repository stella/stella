import type { ReactElement } from "react";

import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
} from "@stll/ui/inspector";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

// Static, SSR-safe placeholder for the client-only `_protected`
// subtree. Mirrors the real shell's shape (left side-rail → sidebar
// column → main content with a header bar) using the same layout
// constants so the skeleton lines up with the chrome that replaces
// it. Intentionally free of hooks, context, data, and Suspense. A page that
// is the same for every visitor can take the content column's place.
export function ProtectedPendingSkeleton({
  content,
}: {
  content?: ReactElement | undefined;
}) {
  return (
    <div
      aria-hidden={content === undefined ? "true" : undefined}
      className="bg-background flex h-full min-h-dvh"
    >
      {/* Sidebar column — matches AppSidebar's 16rem width with a
          header row, a few stacked nav rows, and a footer row. */}
      <div className="bg-sidebar hidden w-64 shrink-0 flex-col gap-2 border-e p-2 md:flex">
        <div
          className={cn("flex shrink-0 items-center gap-2", TOOLBAR_ROW_HEIGHT)}
        >
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton className="h-8 w-full rounded-md" key={index} />
          ))}
        </div>
        <div className="flex-1" />
        <Skeleton className="h-8 w-full shrink-0 rounded-md" />
      </div>

      {/* Main content column — header-height bar + a handful of
          content blocks. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className="h-4 w-40" />
          <div className="ms-auto flex items-center gap-2">
            <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
            <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
          </div>
        </div>
        {content === undefined ? (
          <div className="flex flex-1 flex-col gap-4 p-6">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full rounded-md" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        )}
      </div>

      {/* Right side-rail — same width as the real rail with muted
          icon-sized blocks top and bottom. */}
      <div
        className={cn(
          "bg-muted/50 hidden shrink-0 flex-col border-s md:flex",
          SIDE_RAIL_WIDTH,
        )}
      >
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-b",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
        </div>
        <div className="flex-1" />
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-t",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className={SIDE_RAIL_ICON_BUTTON_SIZE} />
        </div>
      </div>
    </div>
  );
}
