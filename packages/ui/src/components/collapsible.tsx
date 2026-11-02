"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

import { cn } from "../lib/utils";

/**
 * One disclosure: a trigger that shows or hides a single panel ("Show
 * details" under a card, a step list in a transcript). A set of sections
 * where each heading opens its own panel is an `Accordion`.
 *
 * The trigger draws nothing of its own. It takes its look from what it
 * renders, usually a `Button` (`render={<Button variant="muted" />}` for a
 * text toggle), so a disclosure reads like every other action of its size.
 */
const Collapsible = (props: CollapsiblePrimitive.Root.Props) => (
  <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
);

const CollapsibleTrigger = (props: CollapsiblePrimitive.Trigger.Props) => (
  <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
);

/**
 * The disclosed content. It adds no padding or type, so opening it reveals
 * content at the rhythm of the surface around it, as a native `<details>`
 * does. Its height eases open and shut with the accordion's timing, so the
 * two disclosures move alike; under reduced motion it snaps.
 *
 * Closed, the content stays in the document as `hidden="until-found"` (as a
 * native `<details>` keeps it), so find-in-page still reaches it and opens
 * the panel. Pass `hiddenUntilFound={false}` to unmount it instead.
 */
const CollapsiblePanel = ({
  className,
  hiddenUntilFound = true,
  ...props
}: CollapsiblePrimitive.Panel.Props) => (
  <CollapsiblePrimitive.Panel
    className={cn(
      // The accordion panel's motion: Base UI measures the content into
      // `--collapsible-panel-height` and the box eases between it and 0. A
      // class that sets `display` must not undo a plain `hidden`, so only
      // `until-found` keeps the box.
      "h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 ease-in-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden=until-found])]:hidden",
      className,
    )}
    data-slot="collapsible-panel"
    hiddenUntilFound={hiddenUntilFound}
    {...props}
  />
);

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
