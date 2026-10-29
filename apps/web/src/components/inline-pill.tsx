import type {
  HTMLAttributes,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  CHIP_HEIGHT_CLASS,
  CHIP_TOUCH_TARGET_CLASS,
} from "@/components/chip-scale";
import Tooltip from "@/components/tooltip";

/**
 * Inline annotation pill. Renders a small in-flow chip that sits
 * inside paragraph text — mention chips (case-law decisions,
 * entity refs, workspace refs, folio block citations) and
 * round-tripped anonymization pills all funnel through here so
 * the visual contract stays consistent.
 *
 * Two visual concerns are split:
 *
 *  - `tone` picks the colour pair (accent for references, success
 *    for anonymized values).
 *  - `size` picks the typography mode. `"chip"` is the badge look
 *    used by mention references (`text-xs font-medium`); `"inherit"`
 *    keeps the surrounding paragraph's font so the pill reads as
 *    inline prose rather than a UI control.
 *
 * `onActivate` toggles the rendered element: present → focusable
 * `<button type="button">`, absent → `<span>`. `tooltip` wires the
 * shared `<Tooltip>` so hover, focus, and long-press all surface
 * the same content.
 *
 * Not for: external HTTP links (those stay as underlined inline
 * text, no box) or the source-chip tray above message bodies
 * (different shell shape and lives outside the prose flow).
 */
type InlinePillTone = "accent" | "info" | "success";
type InlinePillSize = "chip" | "inherit";

type InlinePillProps = {
  tone?: InlinePillTone;
  size?: InlinePillSize;
  leadingIcon?: ReactNode;
  tooltip?: ReactNode;
  /**
   * Clamp the pill to 14rem or its line, whichever is narrower, and
   * ellipsis the label inside. The mention chips set this; anonymized
   * values do not (their text is the actual prose word being annotated).
   */
  truncate?: boolean;
  onActivate?: MouseEventHandler<HTMLElement> | undefined;
  /**
   * Override the accessible name when the visible text alone
   * doesn't communicate the affordance — anonymized pills set
   * this to "Sent to the model as [PERSON_1]." so screen readers
   * pick up the placeholder, not just the rehydrated name.
   */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
} & Pick<HTMLAttributes<HTMLElement>, "style" | "title"> &
  Record<`data-${string}`, string | undefined>;

const TONE_BASE: Record<InlinePillTone, string> = {
  accent: "bg-accent text-accent-foreground",
  info: "bg-info/12 text-info",
  success: "bg-success/12 text-success",
};

const TONE_INTERACTIVE: Record<InlinePillTone, string> = {
  accent: "hover:bg-accent/80",
  info: "hover:bg-info/20",
  success: "hover:bg-success/20",
};

// A chip takes its height from the chip scale it shares with every
// attachment chip; an inherit pill follows the line it sits in.
const SIZE: Record<InlinePillSize, string> = {
  chip: cn("text-xs font-medium", CHIP_HEIGHT_CLASS, CHIP_TOUCH_TARGET_CLASS),
  inherit: "font-[inherit] text-[inherit] leading-[inherit] py-0.5",
};

const BASE = "inline-flex items-center gap-0.5 align-middle rounded px-1";

export const InlinePill = ({
  tone = "accent",
  size = "chip",
  leadingIcon,
  tooltip,
  truncate = false,
  onActivate,
  ariaLabel,
  className,
  children,
  style,
  title,
  ...dataAttrs
}: InlinePillProps): ReactElement => {
  const clickable = onActivate !== undefined;
  // A `title` names the pill's full text when the label truncates; it shows
  // through the shared tooltip rather than the browser's own hover hint. A
  // title alone does not make the pill a control: it stays a span, so a
  // reference chip in the composer adds no tab stop and no button role.
  const hint = tooltip ?? title;
  const chipKind = size === "chip" ? "reference" : undefined;
  // A tooltip-bearing pill must be keyboard-focusable so screen-
  // reader users (and tab users) can pop the placeholder content,
  // even when the pill itself doesn't trigger an action. Base UI's
  // Tooltip.Trigger reliably attaches hover/focus handlers to a
  // native `<button>`; attaching to a non-focusable element loses
  // the focus path entirely.
  const renderAsButton = clickable || tooltip !== undefined;

  // The inner label span owns truncation. Without `min-w-0` flex
  // children refuse to shrink below their content width and
  // `truncate` becomes a no-op.
  const labelClass = truncate ? "min-w-0 truncate" : undefined;

  const body = (
    <>
      {leadingIcon}
      <span className={cn(labelClass)}>{children}</span>
    </>
  );

  const sharedClass = cn(
    BASE,
    TONE_BASE[tone],
    SIZE[size],
    // The line bound keeps a long label inside a narrow composer or bubble;
    // the 1ch it leaves free holds the space and caret after the chip, which
    // would otherwise wrap onto a line of their own.
    truncate && !renderAsButton && "max-w-[min(14rem,calc(100%-1ch))]",
    renderAsButton && cn("max-w-full", TONE_INTERACTIVE[tone]),
    className,
  );

  // Two render paths because base UI's Tooltip merges its props
  // into a single `render` element — splitting span vs button
  // lets us pin the right semantics without a runtime cast.
  const element = renderAsButton ? (
    // A plain Button draws no box of its own: the pill inside it keeps its
    // height from the chip scale (or the line, for an inherit pill), and the
    // button adds only the focus ring and the line bound.
    <Button
      aria-label={ariaLabel}
      className={cn(
        "inline-flex max-w-full min-w-0",
        size === "inherit" ? "align-baseline" : "align-middle",
        truncate && "max-w-[min(14rem,calc(100%-1ch))]",
        // Annotation-only pills (no click handler) signal "this is
        // informational, hover to see more" rather than "click to
        // activate". `cursor-help` is the standard cue.
        !clickable && "cursor-help",
      )}
      data-chip-kind={chipKind}
      onClick={onActivate}
      variant="plain"
      {...dataAttrs}
    >
      <span className={sharedClass} style={style}>
        {body}
      </span>
    </Button>
  ) : (
    <span
      aria-label={ariaLabel}
      className={sharedClass}
      data-chip-kind={chipKind}
      role="group"
      style={style}
      {...dataAttrs}
    >
      {body}
    </span>
  );

  if (hint === undefined || hint === null || hint === "") {
    return element;
  }

  return <Tooltip content={hint} render={element} />;
};
