"use client";

import { SparklesIcon } from "../icons";
import { cn } from "../lib/utils";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTrigger,
} from "./popover";

type AiLabelProps = {
  /**
   * The words the mark shows ("AI", "AI topics"), already translated. They
   * are also the control's accessible name, so what a sighted reader sees is
   * what a screen-reader user hears.
   */
  label: string;
  /**
   * What the reader is told about the content the mark stands beside, already
   * translated. Hosts pass the sentence for one closed disclosure context
   * (`@stll/api-contract/ai-disclosure`), never free text.
   */
  disclosure: string;
  className?: string | undefined;
};

/**
 * The mark on content a model wrote, and the one place a reader learns what
 * that means.
 *
 * It keeps the weight of the plain label it replaces: the surrounding text's
 * size, colour, case and tracking, a small sparkle, no chip and no tint. The
 * only addition is that it is a button: a click, a tap, Enter or Space opens
 * a small popover with the disclosure, and Escape or a click outside closes
 * it. Nothing depends on hover.
 *
 * The trigger stays inline, so it can sit inside a heading or a line of
 * text. Never inside another control (a `<summary>`, a link, a button): it is
 * one itself, and nested interactive content is unreachable to assistive
 * technology.
 */
export const AiLabel = ({ label, disclosure, className }: AiLabelProps) => (
  <Popover>
    <PopoverTrigger
      className={cn(
        // Inherits the line it sits in; the hit area grows on touch only.
        "focus-visible:ring-ring relative inline-flex cursor-pointer items-center gap-1 rounded-sm align-middle tracking-[inherit] text-inherit [text-transform:inherit] decoration-dotted underline-offset-2 outline-none [font:inherit] hover:underline focus-visible:ring-2 data-popup-open:underline pointer-coarse:after:absolute pointer-coarse:after:-inset-3",
        className,
      )}
      data-slot="ai-label"
      type="button"
    >
      <SparklesIcon aria-hidden className="size-3 shrink-0" />
      {label}
    </PopoverTrigger>
    <PopoverPopup
      aria-label={label}
      className="max-w-72"
      data-slot="ai-label-popup"
      padding="sm"
      side="bottom"
    >
      <PopoverDescription className="text-xs leading-relaxed text-pretty">
        {disclosure}
      </PopoverDescription>
    </PopoverPopup>
  </Popover>
);
