"use client";

import { useRef, useState } from "react";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { useObservedValue } from "../effects/dom";
import { useLayoutSyncEffect } from "../effects/effects";
import { useComposedRefs } from "../effects/refs";
import { hasTabOrderChanged, revealActiveTab } from "../lib/tab-order";
import { cn } from "../lib/utils";
import {
  TABS_INDICATOR_DEFAULT_CLASS,
  TABS_LIST_BASE_CLASS,
  TABS_LIST_DEFAULT_CLASS,
  TABS_TAB_CLASS,
} from "./tabs-classes";

type TabsVariant = "default" | "underline";

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
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const composedListRef = useComposedRefs(setList, ref);
  const tabOrderRef = useRef<readonly Element[]>([]);
  const reordersRef = useRef(0);

  // Re-render once the new order is committed so Base UI's render-time
  // measurement sees where the active tab actually is. `hasTabOrderChanged`
  // explains which case the library misses. Only a new `children` can move
  // the tabs, so the order is read again whenever it changes; the count of
  // reorders is the value, so an unchanged order renders nothing.
  useObservedValue<HTMLDivElement, number>(
    list,
    (observed, emit) => {
      const tabs = [...observed.children];
      if (hasTabOrderChanged(tabOrderRef.current, tabs)) {
        reordersRef.current += 1;
      }
      tabOrderRef.current = tabs;
      emit(reordersRef.current);
      return () => undefined;
    },
    [children],
    0,
  );

  // Base UI reveals the active tab on mount and on focus only, so a strip
  // narrowed later, by a pane docking beside it, would strand it off-screen
  // behind a hidden scrollbar.
  useLayoutSyncEffect(() => {
    if (list === null || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      revealActiveTab(list);
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
    };
  }, [list]);

  return (
    <TabsPrimitive.List
      className={cn(
        TABS_LIST_BASE_CLASS,
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
        // Only the strip's own axis scrolls: the cross axis is clipped, because
        // a tab or action button a pixel taller than the strip otherwise lets
        // touch drag it up and down. Containment stays per axis so a wheel
        // over a horizontal strip still scrolls the page. The bar itself stays
        // hidden: it would take block size from the strip on appearing and
        // paint over the indicator anchored to the strip's edge.
        "scrollbar-none overflow-auto data-[orientation=horizontal]:overflow-y-hidden data-[orientation=horizontal]:overscroll-x-contain data-[orientation=vertical]:overflow-x-hidden data-[orientation=vertical]:overscroll-y-contain [&::-webkit-scrollbar]:hidden",
        "data-[orientation=vertical]:flex-col",
        variant === "default"
          ? TABS_LIST_DEFAULT_CLASS
          : "*:data-[slot=tabs-tab]:hover:bg-accent data-[orientation=horizontal]:py-1 data-[orientation=vertical]:px-1",
        className,
      )}
      data-slot="tabs-list"
      ref={composedListRef}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className={cn(
          "absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) transition-[width,translate] duration-200 ease-in-out",
          variant === "underline"
            ? "bg-primary z-10 data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=vertical]:-translate-x-px"
            : TABS_INDICATOR_DEFAULT_CLASS,
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
    className={cn(TABS_TAB_CLASS, className)}
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
