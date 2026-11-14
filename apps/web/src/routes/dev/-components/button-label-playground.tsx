import type { ReactNode } from "react";

import { Button } from "@stll/ui/button";
import { NewChatIcon } from "@stll/ui/icons";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";

import type { buttonLabelBenches } from "../-visual-metadata";

const LONG_LABEL =
  "Rámcová zmluva o dodávkach elektrokomponentov a náhradných dielov pre výrobu";

/**
 * Buttons with labels wider than the card around them. The cards stack their
 * content at the start (`items-start`), so nothing stretches or caps a button
 * but the button itself: a one-line label is cut inside the card, a wrapping
 * one takes more lines.
 */
const BENCH = {
  "outline-label": <Button variant="outline">{LONG_LABEL}</Button>,
  "icon-label": (
    <Button icon={<NewChatIcon aria-hidden="true" />} size="sm">
      {LONG_LABEL}
    </Button>
  ),
  "popover-trigger": (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        {LONG_LABEL}
      </PopoverTrigger>
      <PopoverPopup>{LONG_LABEL}</PopoverPopup>
    </Popover>
  ),
  "wrap-layout": (
    <Button layout="wrap" variant="outline">
      {LONG_LABEL}
    </Button>
  ),
} as const satisfies Record<keyof typeof buttonLabelBenches, ReactNode>;

export const ButtonLabelPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {Object.entries(BENCH).map(([state, button]) => (
      <section
        className="bg-card flex w-60 flex-col items-start gap-2 rounded-lg border p-3"
        data-playground-section={`button-label:${state}`}
        key={state}
      >
        <h2 className="text-muted-foreground text-xs">{state}</h2>
        {button}
      </section>
    ))}
  </div>
);
