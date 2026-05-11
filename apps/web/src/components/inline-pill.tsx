import type {
  HTMLAttributes,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";

import { cn } from "@stll/ui/lib/utils";

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
export type InlinePillTone = "accent" | "success";
export type InlinePillSize = "chip" | "inherit";

type InlinePillProps = {
  tone?: InlinePillTone;
  size?: InlinePillSize;
  leadingIcon?: ReactNode;
  tooltip?: ReactNode;
  /**
   * Clamp the pill to ~14rem and ellipsis the label inside. The
   * mention chips set this; anonymized values do not (their text
   * is the actual prose word being annotated).
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
  success: "bg-success/12 text-success",
};

const TONE_INTERACTIVE: Record<InlinePillTone, string> = {
  accent: "hover:bg-accent/80",
  success: "hover:bg-success/20",
};

const TONE_FOCUS_RING: Record<InlinePillTone, string> = {
  accent: "focus-visible:ring-accent/50",
  success: "focus-visible:ring-success/50",
};

const SIZE: Record<InlinePillSize, string> = {
  chip: "text-xs font-medium",
  inherit: "font-[inherit] text-[inherit] leading-[inherit]",
};

const BASE =
  "inline-flex items-center gap-0.5 align-middle rounded px-1 py-0.5 transition-colors";

const INTERACTIVE_RESET =
  "appearance-none border-0 bg-clip-padding cursor-pointer focus-visible:outline-none focus-visible:ring-2";

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
      <span className={labelClass}>{children}</span>
    </>
  );

  const sharedClass = cn(
    BASE,
    TONE_BASE[tone],
    SIZE[size],
    truncate && "max-w-56",
    renderAsButton &&
      cn(INTERACTIVE_RESET, TONE_INTERACTIVE[tone], TONE_FOCUS_RING[tone]),
    // Annotation-only pills (no click handler) signal "this is
    // informational, hover to see more" rather than "click to
    // activate". `cursor-help` is the standard cue.
    renderAsButton && !clickable && "cursor-help",
    className,
  );

  // Two render paths because base UI's Tooltip merges its props
  // into a single `render` element — splitting span vs button
  // lets us pin the right semantics without a runtime cast.
  const element = renderAsButton ? (
    <button
      aria-label={ariaLabel}
      className={sharedClass}
      onClick={onActivate}
      style={style}
      title={title}
      type="button"
      {...dataAttrs}
    >
      {body}
    </button>
  ) : (
    <span
      aria-label={ariaLabel}
      className={sharedClass}
      style={style}
      title={title}
      {...dataAttrs}
    >
      {body}
    </span>
  );

  if (tooltip === undefined || tooltip === null || tooltip === "") {
    return element;
  }

  return <Tooltip content={tooltip} render={element} />;
};
