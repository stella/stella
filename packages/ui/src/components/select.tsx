"use client";

import * as React from "react";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cn } from "@stll/ui/lib/utils";
import {
  ChevronDownIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
} from "lucide-react";

type SelectItemProps = SelectPrimitive.Item.Props & {
  label?: string;
};

type ElementWithChildren = React.ReactElement<{
  children?: React.ReactNode;
}>;

const SelectItemDisplaysContext = React.createContext(
  new Map<unknown, React.ReactNode>(),
);

// Look the value up in the displays map even when it is `null` or
// `undefined` — selects intentionally use `null` as a sentinel value
// for "clearable" options (e.g. fallback selectors). When the value
// has no registered display (e.g. nothing selected yet), render the
// caller-supplied placeholder so Base UI's placeholder behaviour is
// preserved despite us overriding `children`.
const renderSelectedDisplay =
  (displays: Map<unknown, React.ReactNode>, placeholder: React.ReactNode) =>
  (value: unknown): React.ReactNode => {
    if (!displays.has(value)) {
      return placeholder ?? null;
    }
    const display = displays.get(value);
    return display ?? null;
  };

function Select<Value, Multiple extends boolean | undefined = false>({
  children,
  itemToStringLabel,
  ...props
}: SelectPrimitive.Root.Props<Value, Multiple>) {
  const itemLabels = collectSelectItemLabels(children);
  const itemDisplays = collectSelectItemDisplays(children);

  const root =
    itemToStringLabel || itemLabels.size === 0 ? (
      <SelectPrimitive.Root itemToStringLabel={itemToStringLabel} {...props}>
        {children}
      </SelectPrimitive.Root>
    ) : (
      <SelectPrimitive.Root
        itemToStringLabel={(value) => {
          const stringValue = String(value);

          return itemLabels.get(value) ?? stringValue;
        }}
        {...props}
      >
        {children}
      </SelectPrimitive.Root>
    );

  return (
    <SelectItemDisplaysContext.Provider value={itemDisplays}>
      {root}
    </SelectItemDisplaysContext.Provider>
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: "sm" | "default" | "lg";
}) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "border-input bg-background text-foreground ring-ring/24 focus-visible:border-ring aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 dark:bg-input/32 dark:aria-invalid:ring-destructive/24 relative inline-flex min-h-9 w-full min-w-36 items-center justify-center gap-2 rounded-lg border px-[calc(--spacing(3)-1px)] text-start text-base shadow-xs/5 transition-shadow outline-none select-none not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-[3px] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-8 sm:text-sm dark:not-data-disabled:not-focus-visible:not-aria-invalid:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [[data-disabled],:focus-visible,[aria-invalid],[data-pressed]]:shadow-none",
        size === "sm" &&
          "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7",
        size === "lg" && "min-h-10 sm:min-h-9",
        className,
      )}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronsUpDownIcon className="-me-1 size-4.5 opacity-80 sm:size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({
  className,
  children,
  placeholder,
  ...props
}: SelectPrimitive.Value.Props) {
  const displays = React.useContext(SelectItemDisplaysContext);

  // If the consumer passed children OR there are no rich displays
  // registered, defer to Base UI's default rendering — same plain
  // styling as before so existing consumers see no visual change.
  if (children !== undefined || displays.size === 0) {
    return (
      <SelectPrimitive.Value
        className={cn(
          "data-placeholder:text-muted-foreground flex-1 truncate",
          className,
        )}
        data-slot="select-value"
        placeholder={placeholder}
        {...props}
      >
        {children}
      </SelectPrimitive.Value>
    );
  }

  // Rich-display path: SelectItems carry icon + text children, so the
  // trigger needs flex/gap to align them like the dropdown row.
  return (
    <SelectPrimitive.Value
      className={cn(
        "data-placeholder:text-muted-foreground flex flex-1 items-center gap-2 truncate",
        className,
      )}
      data-slot="select-value"
      placeholder={placeholder}
      {...props}
    >
      {renderSelectedDisplay(displays, placeholder)}
    </SelectPrimitive.Value>
  );
}

function SelectPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = true,
  collisionAvoidance = {
    align: "shift",
    fallbackAxisSide: "none",
    side: "none",
  },
  ...props
}: SelectPrimitive.Popup.Props & {
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  collisionAvoidance?: SelectPrimitive.Positioner.Props["collisionAvoidance"];
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        alignOffset={alignOffset}
        className="z-50 select-none"
        collisionAvoidance={collisionAvoidance}
        data-slot="select-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className="text-foreground origin-(--transform-origin)"
          data-slot="select-popup"
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow
            className="before:from-popover top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-lg)-1px)] before:bg-linear-to-b before:from-50%"
            data-slot="select-scroll-up-arrow"
          >
            <ChevronUpIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollUpArrow>
          <div className="bg-popover relative h-full min-w-(--anchor-width) rounded-lg border shadow-lg/5 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
            <SelectPrimitive.List
              className={cn(
                "max-h-(--available-height) overflow-y-auto p-1",
                className,
              )}
              data-slot="select-list"
            >
              {children}
            </SelectPrimitive.List>
          </div>
          <SelectPrimitive.ScrollDownArrow
            className="before:from-popover bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-lg)-1px)] before:bg-linear-to-t before:from-50%"
            data-slot="select-scroll-down-arrow"
          >
            <ChevronDownIcon className="relative size-4.5 sm:size-4" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  label: _label,
  ...props
}: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground grid min-h-8 cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemIndicator className="col-start-1">
        <svg
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Selected</title>
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemText className="col-start-2 flex min-w-0 items-center gap-2">
        {children}
      </SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function collectSelectItemLabels(children: React.ReactNode) {
  const labels = new Map<unknown, string>();

  React.Children.forEach(children, (child) => {
    collectSelectItemLabel(child, labels);
  });

  return labels;
}

function collectSelectItemDisplays(children: React.ReactNode) {
  const displays = new Map<unknown, React.ReactNode>();

  React.Children.forEach(children, (child) => {
    collectSelectItemDisplay(child, displays);
  });

  return displays;
}

function collectSelectItemDisplay(
  child: React.ReactNode,
  displays: Map<unknown, React.ReactNode>,
) {
  if (!isElementWithChildren(child)) {
    return;
  }

  if (isSelectItemElement(child)) {
    const value: unknown = child.props.value;
    displays.set(value, child.props.children);
    return;
  }

  React.Children.forEach(child.props.children, (nestedChild) => {
    collectSelectItemDisplay(nestedChild, displays);
  });
}

function collectSelectItemLabel(
  child: React.ReactNode,
  labels: Map<unknown, string>,
) {
  if (!isElementWithChildren(child)) {
    return;
  }

  if (isSelectItemElement(child)) {
    const value: unknown = child.props.value;
    const label = child.props.label ?? getTextLabel(child.props.children);

    if (label) {
      labels.set(value, label);
    }
  }

  React.Children.forEach(child.props.children, (nestedChild) => {
    collectSelectItemLabel(nestedChild, labels);
  });
}

function isElementWithChildren(
  node: React.ReactNode,
): node is ElementWithChildren {
  return React.isValidElement<{ children?: React.ReactNode }>(node);
}

function isSelectItemElement(
  node: React.ReactNode,
): node is React.ReactElement<SelectItemProps> {
  return (
    React.isValidElement<SelectItemProps>(node) && node.type === SelectItem
  );
}

function isReactNodeArray(node: React.ReactNode): node is React.ReactNode[] {
  return Array.isArray(node);
}

function getTextLabel(node: React.ReactNode): string | null {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (isReactNodeArray(node)) {
    const parts: string[] = [];

    React.Children.forEach(node, (child) => {
      const text = getTextLabel(child);

      if (text) {
        parts.push(text);
      }
    });

    return parts.length > 0 ? parts.join("") : null;
  }

  if (isElementWithChildren(node)) {
    return getTextLabel(node.props.children);
  }

  return null;
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      className={cn("bg-border mx-2 my-1 h-px", className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className="text-muted-foreground px-2 py-1.5 text-xs font-medium"
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectPopup as SelectContent,
  SelectItem,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
};
