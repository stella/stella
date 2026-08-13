import type * as React from "react";

import { cn } from "@stll/ui/lib/utils";

type InspectorProps = React.ComponentProps<"aside">;

/**
 * App-agnostic right-side inspector chrome. The inspector itself owns the
 * viewport height; only {@link InspectorContent} scrolls, keeping the header
 * and tabs reachable while inspecting long records.
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

const InspectorTitle = ({
  children,
  className,
  ...props
}: React.ComponentProps<"h2">) => (
  <h2
    className={cn("truncate text-sm font-semibold", className)}
    data-slot="inspector-title"
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
    className={cn("text-muted-foreground truncate text-xs", className)}
    data-slot="inspector-description"
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

const InspectorTabs = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "bg-background flex h-11 shrink-0 items-end gap-1 border-b px-3",
      className,
    )}
    data-slot="inspector-tabs"
    role="tablist"
    {...props}
  />
);

type InspectorTabProps = Omit<React.ComponentProps<"button">, "type"> & {
  active?: boolean;
};

const InspectorTab = ({
  active = false,
  className,
  ...props
}: InspectorTabProps) => (
  <button
    aria-selected={active}
    className={cn(
      "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-11 items-center gap-1.5 border-b-2 border-transparent px-2 text-xs font-medium outline-none focus-visible:ring-2",
      active && "border-primary text-foreground",
      className,
    )}
    data-active={active ? "" : undefined}
    data-slot="inspector-tab"
    role="tab"
    {...props}
    type="button"
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
    className={cn("min-w-0 truncate text-sm font-medium", className)}
    data-slot="inspector-property-value"
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
  InspectorTabs,
  InspectorTitle,
};
