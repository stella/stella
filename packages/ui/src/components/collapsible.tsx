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

/**
 * A bare trigger (plain text, no `render`) still gets the 44px touch target
 * every control has under a coarse pointer, the same hit area `Button` adds.
 */
const CollapsibleTrigger = ({
  className,
  ...props
}: CollapsiblePrimitive.Trigger.Props) => (
  <CollapsiblePrimitive.Trigger
    className={cn(
      "relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
      className,
    )}
    data-slot="collapsible-trigger"
    {...props}
  />
);

/**
 * The disclosed content. It adds no padding or type, so opening it reveals
 * content at the rhythm of the surface around it, as a native `<details>`
 * does. Its height eases open and shut with the accordion's timing, so the
 * two disclosures move alike; under reduced motion it snaps.
 *
 * Closed, the content stays in the document. Once mounted it is
 * `hidden="until-found"` (as a native `<details>` keeps it), so find-in-page
 * reaches it and opens the panel; server-rendered markup carries a plain
 * `hidden` until hydration, so the search reaches it only after that. Pass
 * `hiddenUntilFound={false}` to unmount it instead.
 */
const CollapsiblePanel = ({
  className,
  hiddenUntilFound = true,
  ...props
}: CollapsiblePrimitive.Panel.Props) => (
  <CollapsiblePrimitive.Panel
    className={cn(
      // Motion and its temporary clipping belong to the theme's panel
      // keyframes. Settled-open content can extend beyond the panel (for
      // example, a document's hanging permalink). Plain hidden must still
      // remove the box; hidden-until-found retains the searchable content.
      "h-(--collapsible-panel-height) min-w-0 data-ending-style:h-0 data-starting-style:h-0 [&[hidden]:not([hidden=until-found])]:hidden",
      className,
    )}
    data-slot="collapsible-panel"
    hiddenUntilFound={hiddenUntilFound}
    {...props}
  />
);

export { Collapsible, CollapsiblePanel, CollapsibleTrigger };
