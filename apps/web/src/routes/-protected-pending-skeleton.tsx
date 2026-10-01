import type { ReactElement } from "react";

import {
  HelpCircleIcon,
  NewChatIcon,
  PanelLeftIcon,
  PanelRightIcon,
} from "@stll/ui/icons";
import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
} from "@stll/ui/inspector";
import { Skeleton } from "@stll/ui/skeleton";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { cn } from "@stll/ui/utils";

import { StellaWordmarkArabic } from "@/components/stella-wordmark";
import { getWorkspacePrimaryNavItems } from "@/components/workspace-primary-nav";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

// The primary entries every signed-in person sees, from the same list the
// real sidebar renders. Flag-gated entries (inbox, timesheets, case law) join
// once the real sidebar mounts, rather than flashing in and out here.
const STATIC_NAV_ITEMS = getWorkspacePrimaryNavItems({
  includeInbox: false,
  includePublicLaw: false,
  includePublicTools: false,
  includeTimesheets: false,
  publicKnowledge: false,
});
const NAV_LABEL_WIDTHS = ["w-14", "w-10", "w-16", "w-20", "w-16"] as const;
const PINNED_ROW_KEYS = ["a", "b", "c"] as const;

// Static, SSR-safe placeholder for the client-only `_protected` subtree.
// Chrome that needs no data renders for real (the logo, the primary nav
// icons, the rail toggles), so the frame is already the app; only what
// depends on data or on the active locale shimmers: nav labels, pinned
// matters, the account card, the breadcrumb and the page body. Intentionally
// free of hooks, context, data, and Suspense. A page that is the same for
// every visitor can take the content column's place.
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
      {/* Sidebar column: AppSidebar's 16rem width, logo header, primary nav,
          pinned matters, help, account. */}
      <div className="bg-sidebar hidden w-64 shrink-0 flex-col border-e md:flex">
        <div
          className={cn(
            "flex shrink-0 items-center justify-between border-b ps-3 pe-2",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          {/* The prepaint script sets `dir` before first paint, so the
              right lockup shows without a locale hook. */}
          <StellaWordmarkLatin className="h-5 w-auto rtl:hidden" />
          <StellaWordmarkArabic className="hidden h-5 w-auto rtl:block" />
          <span
            className={cn(
              "text-muted-foreground grid place-items-center",
              SIDE_RAIL_ICON_BUTTON_SIZE,
            )}
          >
            <PanelLeftIcon className="size-4" />
          </span>
        </div>
        <div className="flex flex-col gap-1 p-2">
          {STATIC_NAV_ITEMS.map((item, index) => (
            <div className="flex h-8 items-center gap-2 px-2" key={item.id}>
              <item.icon className="text-muted-foreground size-4 shrink-0" />
              <Skeleton
                className={cn("h-3", NAV_LABEL_WIDTHS[index] ?? "w-16")}
              />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1 border-t p-2">
          {PINNED_ROW_KEYS.map((key) => (
            <div className="flex h-9 items-center gap-2 px-2" key={key}>
              <Skeleton className="size-4 rounded-sm" />
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2 w-20" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex flex-col gap-1 p-2">
          <div className="flex h-8 items-center gap-2 px-2">
            <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="flex h-12 items-center gap-2 px-2">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex flex-1 flex-col gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2 w-28" />
            </div>
          </div>
        </div>
      </div>

      {/* Main content column: header bar (breadcrumb) + page body. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-3 border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Skeleton className="h-4 w-40" />
        </div>
        {content === undefined ? (
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
            <Skeleton className="h-7 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{content}</div>
        )}
      </div>

      {/* Right side rail: the real toggle and new-chat icons, no tabs yet. */}
      <div
        className={cn(
          "bg-muted/50 text-muted-foreground hidden shrink-0 flex-col border-s md:flex",
          SIDE_RAIL_WIDTH,
        )}
      >
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-b",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <PanelRightIcon className="size-4" />
        </div>
        <div className="flex-1" />
        <div
          className={cn(
            "flex w-full shrink-0 items-center justify-center border-t",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <NewChatIcon className="size-4" />
        </div>
      </div>
    </div>
  );
}
