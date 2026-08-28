"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { useViewportWidth } from "../hooks/use-viewport-width";
import { cn } from "../lib/utils";
import { TOOLBAR_ROW_HEIGHT } from "./layout-tokens";

const inspectorRailBreakpointPx = 768;

export const resolveInspectorTabOrientation = (viewportWidth: number) =>
  viewportWidth >= inspectorRailBreakpointPx ? "vertical" : "horizontal";

/**
 * A tabbed inspector keeps its content beside the same fixed-width rail as a
 * docked inspector. The mobile layout moves the rail below the header rather
 * than leaving a narrow column beside a full-screen sheet.
 */
export const InspectorTabs = ({
  className,
  ...props
}: Omit<TabsPrimitive.Root.Props, "orientation">) => {
  const viewportWidth = useViewportWidth();

  return (
    <TabsPrimitive.Root
      className={cn(
        "grid h-full min-h-0 w-full grid-cols-1 grid-rows-[3rem_3rem_minmax(0,1fr)] overflow-hidden md:grid-cols-[3rem_minmax(0,1fr)] md:grid-rows-[3rem_minmax(0,1fr)]",
        className,
      )}
      data-slot="inspector-tabs"
      {...props}
      orientation={resolveInspectorTabOrientation(viewportWidth)}
    />
  );
};

export const InspectorTabList = ({
  className,
  ...props
}: TabsPrimitive.List.Props) => (
  <TabsPrimitive.List
    className={cn(
      "bg-sidebar col-start-1 row-start-2 flex min-w-0 shrink-0 scrollbar-none overflow-x-auto overflow-y-hidden overscroll-x-contain border-b md:row-span-2 md:row-start-1 md:h-full md:flex-col md:overflow-x-hidden md:overflow-y-auto md:overscroll-y-contain md:border-s md:border-e md:border-b-0 [&::-webkit-scrollbar]:hidden",
      TOOLBAR_ROW_HEIGHT,
      "md:w-12",
      className,
    )}
    data-slot="inspector-tab-list"
    {...props}
  />
);

export const InspectorTab = ({
  className,
  ...props
}: TabsPrimitive.Tab.Props) => (
  <TabsPrimitive.Tab
    className={cn(
      "group/tab text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring data-active:bg-background data-active:text-foreground data-active:before:bg-primary relative flex min-h-8 flex-1 cursor-pointer items-center justify-center border-e transition-colors outline-none before:absolute before:inset-x-0 before:bottom-0 before:hidden before:h-0.5 focus-visible:z-10 focus-visible:ring-2 data-active:before:block data-disabled:pointer-events-none data-disabled:opacity-60 md:w-full md:flex-none md:border-e-0 md:border-b md:before:inset-y-0 md:before:start-0 md:before:h-auto md:before:w-0.5",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="inspector-tab"
    {...props}
  />
);

export const InspectorTabPanel = ({
  className,
  ...props
}: TabsPrimitive.Panel.Props) => (
  <TabsPrimitive.Panel
    className={cn(
      "col-start-1 row-start-3 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain outline-none md:col-start-2 md:row-start-2",
      className,
    )}
    data-slot="inspector-tab-panel"
    {...props}
  />
);
