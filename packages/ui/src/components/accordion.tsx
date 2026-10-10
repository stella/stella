"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";

import { ChevronDownIcon } from "../icons";
import { cn } from "../lib/utils";

const Accordion = <Value = unknown,>(
  props: AccordionPrimitive.Root.Props<Value>,
) => <AccordionPrimitive.Root data-slot="accordion" {...props} />;

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

const AccordionTrigger = ({
  className,
  children,
  size = "default",
  ...props
}: AccordionPrimitive.Trigger.Props & { size?: "default" | "compact" }) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      className={cn(
        "focus-visible:ring-ring flex flex-1 cursor-pointer items-start justify-between gap-4 rounded-md text-start font-medium outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-64 data-panel-open:*:data-[slot=accordion-indicator]:rotate-180",
        size === "compact" ? "py-2 text-xs" : "py-4 text-sm",
        className,
      )}
      data-slot="accordion-trigger"
      {...props}
    >
      {children}
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
}: AccordionPrimitive.Panel.Props & { size?: "default" | "compact" }) => (
  <AccordionPrimitive.Panel
    className="text-muted-foreground h-(--accordion-panel-height) overflow-hidden text-sm transition-[height] duration-200 ease-in-out data-ending-style:h-0 data-starting-style:h-0"
    data-slot="accordion-panel"
    {...props}
  >
    <div
      className={cn("pt-0", size === "compact" ? "pb-3" : "pb-4", className)}
    >
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
