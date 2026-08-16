import type * as React from "react";

import { Tabs, TabsList, TabsPanel, TabsTab } from "@stll/ui/components/tabs";
import { cn } from "@stll/ui/lib/utils";

type InspectorProps = React.ComponentProps<"aside">;

/**
 * App-agnostic right-side inspector chrome. The inspector itself owns the
 * viewport height; only its content or active tab panel scrolls, keeping the
 * header and tabs reachable while inspecting long records.
 */
const Inspector = ({ className, ...props }: InspectorProps) => (
  <aside
    className={cn(
      "bg-background text-foreground flex h-full min-h-0 w-full flex-col overflow-hidden border-s shadow-lg",
      className,
    )}
    data-slot="inspector"
    {...props}
  />
);

const InspectorHeader = ({
  className,
  ...props
}: React.ComponentProps<"header">) => (
  <header
    className={cn(
      "bg-background flex h-12 shrink-0 items-center gap-3 border-b px-3",
      className,
    )}
    data-slot="inspector-header"
    {...props}
  />
);

const InspectorHeaderText = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("min-w-0 flex-1", className)}
    data-slot="inspector-header-text"
    {...props}
  />
);

// Record-data slots (title, description, property value) hold caller-supplied
// values such as case numbers, ECLI identifiers, and filenames. They isolate
// their own bidi context so a Latin value inside an RTL inspector keeps its
// character order and truncates from the correct end. Chrome slots stay in the
// surrounding direction. `dir` precedes the prop spread so callers can force a
// direction. `inspector.test.tsx` pins which slots belong to each group.
const InspectorTitle = ({
  children,
  className,
  ...props
}: React.ComponentProps<"h2">) => (
  <h2
    className={cn(
      "truncate text-sm font-semibold [unicode-bidi:isolate]",
      className,
    )}
    data-slot="inspector-title"
    dir="auto"
    {...props}
  >
    {children}
  </h2>
);

const InspectorDescription = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <p
    className={cn(
      "text-muted-foreground truncate text-xs [unicode-bidi:isolate]",
      className,
    )}
    data-slot="inspector-description"
    dir="auto"
    {...props}
  />
);

const InspectorActions = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("ms-auto flex shrink-0 items-center gap-1", className)}
    data-slot="inspector-actions"
    {...props}
  />
);

// `orientation` is omitted rather than passed through: the tabs root turns
// `flex-row` when vertical, but the tab list is sized as a horizontal strip
// (`h-11 w-full shrink-0`), so a vertical inspector would give the whole width
// to the list and clip the panel against this root's `overflow-hidden`.
// Supporting it needs vertical list sizing, so the shell excludes it instead of
// exposing a prop that silently breaks the layout.
const InspectorTabs = ({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Tabs>, "orientation">) => (
  <Tabs
    className={cn("min-h-0 flex-1 gap-0 overflow-hidden", className)}
    data-slot="inspector-tabs"
    {...props}
  />
);

const InspectorTabList = ({
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsList>, "variant">) => (
  <TabsList
    className={cn(
      "bg-background h-11 w-full shrink-0 justify-start gap-1 border-b px-3 py-0",
      className,
    )}
    data-slot="inspector-tab-list"
    variant="underline"
    {...props}
  />
);

const InspectorTab = ({
  className,
  ...props
}: React.ComponentProps<typeof TabsTab>) => (
  <TabsTab
    className={cn(
      "h-11 grow-0 rounded-none px-2 text-xs sm:h-11 sm:text-xs",
      className,
    )}
    data-slot="inspector-tab"
    {...props}
  />
);

const InspectorTabPanel = ({
  className,
  ...props
}: React.ComponentProps<typeof TabsPanel>) => (
  <TabsPanel
    className={cn(
      "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
      className,
    )}
    data-slot="inspector-tab-panel"
    {...props}
  />
);

const InspectorContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
      className,
    )}
    data-slot="inspector-content"
    {...props}
  />
);

const InspectorSection = ({
  className,
  ...props
}: React.ComponentProps<"section">) => (
  <section
    className={cn("border-b px-3 py-3 last:border-b-0", className)}
    data-slot="inspector-section"
    {...props}
  />
);

const InspectorSectionTitle = ({
  children,
  className,
  ...props
}: React.ComponentProps<"h3">) => (
  <h3
    className={cn(
      "text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase",
      className,
    )}
    data-slot="inspector-section-title"
    {...props}
  >
    {children}
  </h3>
);

const InspectorPropertyList = ({
  className,
  ...props
}: React.ComponentProps<"dl">) => (
  <dl
    className={cn("divide-y", className)}
    data-slot="inspector-property-list"
    {...props}
  />
);

const InspectorProperty = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "grid min-h-9 grid-cols-[minmax(6rem,2fr)_minmax(0,3fr)] items-center gap-3 py-2",
      className,
    )}
    data-slot="inspector-property"
    {...props}
  />
);

const InspectorPropertyLabel = ({
  className,
  ...props
}: React.ComponentProps<"dt">) => (
  <dt
    className={cn("text-muted-foreground min-w-0 text-xs", className)}
    data-slot="inspector-property-label"
    {...props}
  />
);

const InspectorPropertyValue = ({
  className,
  ...props
}: React.ComponentProps<"dd">) => (
  <dd
    className={cn(
      "min-w-0 truncate text-sm font-medium [unicode-bidi:isolate]",
      className,
    )}
    data-slot="inspector-property-value"
    dir="auto"
    {...props}
  />
);

export {
  Inspector,
  InspectorActions,
  InspectorContent,
  InspectorDescription,
  InspectorHeader,
  InspectorHeaderText,
  InspectorProperty,
  InspectorPropertyLabel,
  InspectorPropertyList,
  InspectorPropertyValue,
  InspectorSection,
  InspectorSectionTitle,
  InspectorTab,
  InspectorTabList,
  InspectorTabPanel,
  InspectorTabs,
  InspectorTitle,
};
