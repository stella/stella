// The tab strip's classes, with no React or Base UI: the tabs (./tabs.tsx)
// render them, and a loading view draws a strip's face (./control-face.tsx)
// from the same classes, so the strip in a pending view and the tabs that
// replace it share one box.

/** The strip's layout, for every variant. */
export const TABS_LIST_BASE_CLASS =
  "text-muted-foreground relative z-0 flex w-fit max-w-full items-center justify-center-safe gap-x-0.5";

/** The `default` strip's well. */
export const TABS_LIST_DEFAULT_CLASS =
  "bg-muted text-foreground-label rounded-lg p-0.5";

/** One tab's box, type and states. */
export const TABS_TAB_CLASS =
  "hover:text-foreground focus-visible:ring-ring data-active:text-foreground relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-base font-medium whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-inset data-disabled:pointer-events-none data-disabled:opacity-64 data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start sm:h-8 sm:text-sm [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

/** The `default` strip's raised chip under the active tab. */
export const TABS_INDICATOR_DEFAULT_CLASS =
  "bg-background dark:bg-input -z-1 rounded-md shadow-sm/5";
