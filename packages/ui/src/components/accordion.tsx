"use client";

import type * as React from "react";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";

import { ChevronDownIcon } from "../icons";
import { cn } from "../lib/utils";

/**
 * Closed panels stay in the document as `hidden="until-found"`, so
 * find-in-page reaches their content and opens the section, as it would a
 * native `<details>`. Pass `hiddenUntilFound={false}` (here, or on one
 * `AccordionPanel`) to unmount closed content instead: a heavy panel that
 * should not render until asked for.
 */
const Accordion = <Value = unknown,>({
  hiddenUntilFound = true,
  ...props
}: AccordionPrimitive.Root.Props<Value>) => (
  <AccordionPrimitive.Root
    data-slot="accordion"
    hiddenUntilFound={hiddenUntilFound}
    {...props}
  />
);

const AccordionItem = ({
  className,
  ...props
}: AccordionPrimitive.Item.Props) => (
  <AccordionPrimitive.Item
    className={cn("border-b last:border-b-0", className)}
    data-slot="accordion-item"
    {...props}
  />
);

/**
 * - `default`: a section heading of a page or panel.
 * - `sm`: body-size type at a 44px row, for a disclosure inside a dialog or
 *   card ("Show all permissions", advanced options).
 * - `compact`: small type in a dense list.
 */
type AccordionSize = "default" | "sm" | "compact";

const TRIGGER_SIZE_CLASS_NAME = {
  compact: "py-2 text-xs",
  default: "py-4 text-sm",
  sm: "min-h-11 items-center py-2 text-sm",
} as const satisfies Record<AccordionSize, string>;

const PANEL_SIZE_CLASS_NAME = {
  compact: "pb-3",
  default: "pb-4",
  sm: "pb-2",
} as const satisfies Record<AccordionSize, string>;

/**
 * - `default`: the trigger reads as a heading.
 * - `muted`: a quiet "show more" line in muted body weight that brightens on
 *   hover, for a disclosure that is secondary to what is around it.
 */
type AccordionTriggerVariant = "default" | "muted";

const TRIGGER_VARIANT_CLASS_NAME = {
  default: "font-medium",
  muted: "text-muted-foreground hover:text-foreground font-normal",
} as const satisfies Record<AccordionTriggerVariant, string>;

const AccordionTrigger = ({
  className,
  children,
  size = "default",
  variant = "default",
  trailing,
  ...props
}: AccordionPrimitive.Trigger.Props & {
  size?: AccordionSize;
  variant?: AccordionTriggerVariant;
  /**
   * Status at the end of the row, before the chevron: a count, "2 unsaved",
   * a last-updated date. It is part of the trigger, so it is read with the
   * heading; it is text, never a control (a button inside a button is
   * unreachable).
   */
  trailing?: React.ReactNode;
}) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      className={cn(
        "focus-visible:ring-ring flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md text-start outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-64 data-panel-open:*:data-[slot=accordion-indicator]:rotate-180",
        TRIGGER_SIZE_CLASS_NAME[size],
        TRIGGER_VARIANT_CLASS_NAME[variant],
        className,
      )}
      data-slot="accordion-trigger"
      {...props}
    >
      {children}
      {trailing === undefined ? null : (
        <span
          className="text-muted-foreground ms-auto shrink-0 text-xs font-normal tabular-nums"
          data-slot="accordion-trigger-trailing"
        >
          {trailing}
        </span>
      )}
      <ChevronDownIcon
        className="pointer-events-none size-4 shrink-0 translate-y-0.5 opacity-80 transition-transform duration-200 ease-in-out"
        data-slot="accordion-indicator"
      />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
);

const AccordionPanel = ({
  className,
  children,
  size = "default",
  ...props
}: AccordionPrimitive.Panel.Props & { size?: AccordionSize }) => (
  <AccordionPrimitive.Panel
    className="text-muted-foreground h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-200 ease-in-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden=until-found])]:hidden"
    data-slot="accordion-panel"
    {...props}
  >
    <div className={cn("pt-0", PANEL_SIZE_CLASS_NAME[size], className)}>
      {children}
    </div>
  </AccordionPrimitive.Panel>
);

export {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
  AccordionPanel as AccordionContent,
};
