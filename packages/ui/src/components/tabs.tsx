"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { hasTabOrderChanged } from "../lib/tab-order";
import { cn, composeRefs } from "../lib/utils";

type TabsVariant = "default" | "underline";

// Layout effects never run while rendering on the server, so fall back to
// `useEffect` there to avoid React's server-side layout-effect warning.
const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const Tabs = ({ className, ...props }: TabsPrimitive.Root.Props) => (
  <TabsPrimitive.Root
    className={cn(
      "flex flex-col gap-2 data-[orientation=vertical]:flex-row",
      className,
    )}
    data-slot="tabs"
    {...props}
  />
);

const TabsList = ({
  variant = "default",
  className,
  children,
  ref,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabOrderRef = useRef<readonly Element[]>([]);
  const [, setRemeasureToken] = useState(0);

  // Re-render once the new order is committed so Base UI's render-time
  // measurement sees where the active tab actually is. `hasTabOrderChanged`
  // explains which case the library misses.
  useIsoLayoutEffect(() => {
    const tabs = listRef.current ? [...listRef.current.children] : [];
    const previousTabs = tabOrderRef.current;
    tabOrderRef.current = tabs;

    if (hasTabOrderChanged(previousTabs, tabs)) {
      setRemeasureToken((token) => token + 1);
    }
  });

  return (
    <TabsPrimitive.List
      className={cn(
        "text-muted-foreground relative z-0 flex w-fit max-w-full items-center justify-center-safe gap-x-0.5",
        // A list narrower than its tabs used to clip them with no way to reach
        // them, so the list scrolls itself. `w-fit` alone cannot deliver that:
        // the tabs are `shrink-0 whitespace-nowrap`, so the list's min-content
        // width equals its max-content width and `fit-content` never shrinks,
        // leaving the strip overflowing its parent rather than scrolling.
        // `max-w-full` caps it at the available width, which is what turns that
        // overflow into scrollable overflow; `w-fit` still hugs a strip that
        // fits. The scroll container has to be this element: Base UI drives it
        // as the composite root, so it scrolls the active tab into view on
        // mount and the focused one during arrow navigation (honouring
        // `scroll-margin` on the tab), and it measures the indicator against
        // this element's scroll origin. `safe center` falls back to start
        // alignment once the strip overflows, because plain centring puts the
        // leading tabs at a negative offset, outside the scrollable area.
        // Scrolling one axis computes the other to `auto` anyway, hence both,
        // but containment stays per axis so a wheel over a horizontal strip
        // still scrolls the page. The bar itself stays hidden: it would take
        // block size from the strip on appearing and paint over the indicator
        // anchored to the strip's edge.
        "scrollbar-none overflow-auto data-[orientation=horizontal]:overscroll-x-contain data-[orientation=vertical]:overscroll-y-contain [&::-webkit-scrollbar]:hidden",
        "data-[orientation=vertical]:flex-col",
        variant === "default"
          ? "bg-muted text-foreground-label rounded-lg p-0.5"
          : "*:data-[slot=tabs-tab]:hover:bg-accent data-[orientation=horizontal]:py-1 data-[orientation=vertical]:px-1",
        className,
      )}
      data-slot="tabs-list"
      ref={composeRefs(listRef, ref)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className={cn(
          "absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) transition-[width,translate] duration-200 ease-in-out",
          variant === "underline"
            ? "bg-primary z-10 data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px"
            : "bg-background dark:bg-input -z-1 rounded-md shadow-sm/5",
        )}
        data-slot="tab-indicator"
      />
    </TabsPrimitive.List>
  );
};

// The ring is drawn inside the tab, not around it: the list is a scroll
// container, and a ring painted outside the tab's box is ink overflow, which a
// scroll container clips rather than scrolls to. Inset is the one placement
// that survives whatever padding a consumer gives the list.
const TabsTab = ({ className, ...props }: TabsPrimitive.Tab.Props) => (
  <TabsPrimitive.Tab
    className={cn(
      "hover:text-foreground focus-visible:ring-ring data-active:text-foreground relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-base font-medium whitespace-nowrap transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-inset data-disabled:pointer-events-none data-disabled:opacity-64 data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start sm:h-8 sm:text-sm [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
      className,
    )}
    data-slot="tabs-tab"
    {...props}
  />
);

const TabsPanel = ({ className, ...props }: TabsPrimitive.Panel.Props) => (
  <TabsPrimitive.Panel
    className={cn("flex-1 outline-none", className)}
    data-slot="tabs-content"
    {...props}
  />
);

export {
  Tabs,
  TabsList,
  TabsTab,
  TabsTab as TabsTrigger,
  TabsPanel,
  TabsPanel as TabsContent,
};
