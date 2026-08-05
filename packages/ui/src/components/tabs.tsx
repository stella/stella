"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { hasTabOrderChanged } from "@stll/ui/lib/tab-order";
import { cn, composeRefs } from "@stll/ui/lib/utils";

type TabsVariant = "default" | "underline";

// Layout effects never run while rendering on the server, so fall back to
// `useEffect` there to avoid React's server-side layout-effect warning.
const useIsoLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn(
        "flex flex-col gap-2 data-[orientation=vertical]:flex-row",
        className,
      )}
      data-slot="tabs"
      {...props}
    />
  );
}

function TabsList({
  variant = "default",
  className,
  children,
  ref,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabOrderRef = useRef<readonly Element[]>([]);
  const [, setRemeasureToken] = useState(0);

  // Re-render once the new order is committed so Base UI's render-time
  // measurement sees where the active tab actually is. See `hasTabOrderChanged`
  // for why the library cannot correct this itself.
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
        "text-muted-foreground relative z-0 flex w-fit items-center justify-center gap-x-0.5",
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
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "hover:text-foreground focus-visible:ring-ring data-active:text-foreground relative flex h-9 shrink-0 grow cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-[calc(--spacing(2.5)-1px)] text-base font-medium whitespace-nowrap transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 data-disabled:pointer-events-none data-disabled:opacity-64 data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start sm:h-8 sm:text-sm [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export {
  Tabs,
  TabsList,
  TabsTab,
  TabsTab as TabsTrigger,
  TabsPanel,
  TabsPanel as TabsContent,
};
