import { useRef, useState } from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { panic } from "better-result";

import { Button } from "@stll/ui/button";
import { HorizontalScroller } from "@stll/ui/horizontal-scroller";
import { cn } from "@stll/ui/utils";

import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

type SuggestedAction = {
  id: string;
  label: string;
  icon?: ReactNode;
};

export type SuggestedActionSurfaceName = "plain" | "floating" | "overlay";

/**
 * `row` keeps chips on one line that scrolls sideways, with scroll controls
 * the caller labels; `wrap` lays chips out over multiple rows; `vertical`
 * stacks them.
 */
type SuggestedActionsLayout =
  | { orientation?: "vertical" | "wrap"; scrollLabels?: never }
  | { orientation: "row"; scrollLabels: { next: string; previous: string } };

type SuggestedActionsProps = SuggestedActionsLayout & {
  actions: SuggestedAction[];
  onSelect: (id: string) => void;
  /** Accessible group label (callers pass a translated string). */
  label: string;
  /**
   * `plain` suits a solid background. `floating` gives each chip an opaque
   * surface so it reads cleanly over document/editor content. `overlay` is
   * translucent with a slight backdrop blur, for floating over scrolling
   * text that should stay faintly visible behind the chips.
   */
  surface?: SuggestedActionSurfaceName;
  /** Keyboard hint surfaced on each chip via `aria-keyshortcuts`. */
  keyShortcut?: string;
  className?: string;
};

// Opaque chip backdrop for the `floating` surface: white in light mode,
// the popover token in dark, so chips read cleanly over arbitrary
// document content rather than going translucent on hover.
const FLOATING_SURFACE_CLASS =
  "border-foreground/15 border shadow-floating [--suggested-surface:var(--color-white)] dark:[--suggested-surface:var(--popover)] bg-(--suggested-surface)";

// Translucent + slightly blurred backdrop for the `overlay` surface: chips
// float over scrolling content (the chat message list) and stay readable
// while the text behind shows through, blurred.
const OVERLAY_SURFACE_CLASS =
  "border-foreground/10 bg-background/70 border shadow-sm backdrop-blur-sm";

type SuggestedActionSurfaceProps = ComponentProps<"span"> & {
  surface: SuggestedActionSurfaceName;
};

const SuggestedActionSurface = ({
  className,
  surface,
  ...props
}: SuggestedActionSurfaceProps) => (
  <span
    className={cn(
      "inline-flex rounded-full",
      surface === "floating" && FLOATING_SURFACE_CLASS,
      surface === "overlay" && OVERLAY_SURFACE_CLASS,
      className,
    )}
    {...props}
  />
);

/**
 * Where a truncated label is in its reveal. `rest` shows the ellipsis;
 * `revealing` slides the hidden end into view; `returning` slides back and
 * hands over to `rest` once the label is home, so the ellipsis never jumps
 * in under a label that is still moving.
 */
type LabelReveal =
  | { type: "rest" }
  | { type: "revealing"; offsetPx: number; durationMs: number }
  | { type: "returning" };

// A reading pace, not interface feedback: the label moves slowly enough to
// read while it passes, so its duration grows with the hidden length and
// is set per label instead of through a duration utility.
const REVEAL_PX_PER_SECOND = 45;
const REVEAL_MIN_DURATION_MS = 400;
// A pointer crossing the row on its way elsewhere starts no slide.
const REVEAL_DELAY_MS = 250;
const RETURN_DURATION_MS = 200;

const revealDurationMs = (hiddenPx: number): number =>
  Math.max(
    REVEAL_MIN_DURATION_MS,
    Math.round((hiddenPx / REVEAL_PX_PER_SECOND) * 1000),
  );

const labelRevealStyle = (reveal: LabelReveal): CSSProperties | undefined => {
  switch (reveal.type) {
    case "rest":
      return undefined;
    case "revealing":
      return {
        transitionDelay: `${String(REVEAL_DELAY_MS)}ms`,
        transitionDuration: `${String(reveal.durationMs)}ms`,
        translate: `${String(reveal.offsetPx)}px 0`,
      };
    case "returning":
      return {
        transitionDuration: `${String(RETURN_DURATION_MS)}ms`,
        translate: "0 0",
      };
    default:
      reveal satisfies never;
      return panic(`Unhandled label reveal: ${String(reveal)}`);
  }
};

// The computed `translate` of a label that has not moved yet, as browsers
// and the test DOM spell it.
const UNMOVED_TRANSLATE = new Set(["", "none", "0px", "0px 0px"]);

type SuggestedActionChipProps = {
  action: SuggestedAction;
  /** Sizing within the group: a scrolling row keeps each chip whole. */
  className: string;
  keyShortcut: string | undefined;
  onSelect: (id: string) => void;
  surface: SuggestedActionSurfaceName;
};

/**
 * One chip. A label too long for the row ends in an ellipsis; hovering or
 * focusing the chip slides the rest of the label into view inside the chip's
 * own box, so the row never reflows. With reduced motion the label stays put
 * and the chip's tooltip shows the whole text instead.
 */
const SuggestedActionChip = ({
  action,
  className,
  keyShortcut,
  onSelect,
  surface,
}: SuggestedActionChipProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const clipRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const engagedRef = useRef({ focus: false, hover: false });
  const [reveal, setReveal] = useState<LabelReveal>({ type: "rest" });

  const engage = (source: "focus" | "hover") => {
    engagedRef.current[source] = true;
    const clip = clipRef.current;
    const label = labelRef.current;
    if (prefersReducedMotion || clip === null || label === null) {
      return;
    }
    const hiddenPx = label.scrollWidth - clip.clientWidth;
    if (hiddenPx <= 0) {
      return;
    }
    // Toward the start: left in a left-to-right label, right in a
    // right-to-left one (`dir="auto"` resolves per label).
    const towardStart = getComputedStyle(label).direction === "rtl" ? 1 : -1;
    setReveal({
      type: "revealing",
      durationMs: revealDurationMs(hiddenPx),
      offsetPx: towardStart * hiddenPx,
    });
  };

  const release = (source: "focus" | "hover") => {
    engagedRef.current[source] = false;
    if (engagedRef.current.focus || engagedRef.current.hover) {
      return;
    }
    const label = labelRef.current;
    // Released before the delay ran out: nothing moved, so no transition
    // will end to hand back to `rest`.
    const moved =
      label !== null &&
      !UNMOVED_TRANSLATE.has(getComputedStyle(label).translate);
    setReveal((current) => {
      if (current.type !== "revealing") {
        return current;
      }
      return moved ? { type: "returning" } : { type: "rest" };
    });
  };

  const settle = () => {
    setReveal((current) =>
      current.type === "returning" ? { type: "rest" } : current,
    );
  };

  return (
    <SuggestedActionSurface className={className} surface={surface}>
      <Button
        aria-keyshortcuts={keyShortcut}
        className={cn("text-foreground font-normal", "max-w-full")}
        onBlur={() => release("focus")}
        onClick={() => onSelect(action.id)}
        onFocus={() => engage("focus")}
        onPointerEnter={() => engage("hover")}
        onPointerLeave={() => release("hover")}
        size="chip"
        tooltip={prefersReducedMotion ? action.label : undefined}
        type="button"
        variant={surface === "plain" ? "outline" : "ghost"}
      >
        {action.icon}
        <span className="min-w-0 overflow-hidden" ref={clipRef}>
          <span
            className={cn(
              "block whitespace-nowrap ease-in-out",
              reveal.type === "rest"
                ? "truncate"
                : "w-max transition-transform",
            )}
            data-reveal={reveal.type}
            dir="auto"
            onTransitionCancel={settle}
            onTransitionEnd={settle}
            ref={labelRef}
            style={labelRevealStyle(reveal)}
          >
            {action.label}
          </span>
        </span>
      </Button>
    </SuggestedActionSurface>
  );
};

/**
 * A row, wrapping row or stack of click-to-run suggested-action chips.
 */
export const SuggestedActions = ({
  actions,
  onSelect,
  label,
  orientation = "wrap",
  scrollLabels,
  surface = "plain",
  keyShortcut,
  className,
}: SuggestedActionsProps) => {
  if (actions.length === 0) {
    return null;
  }

  const row = orientation === "row";

  const group = (
    <div
      aria-label={label}
      className={cn(
        "flex gap-1.5",
        // The scroller's viewport clips; the padding keeps the chips' shadow.
        row ? "flex-nowrap items-center py-1" : "max-w-full items-start",
        orientation === "wrap" && "flex-wrap",
        orientation === "vertical" && "flex-col",
        className,
      )}
      role="group"
    >
      {actions.map((action) => (
        <SuggestedActionChip
          action={action}
          className={cn(row ? "shrink-0" : "max-w-full")}
          key={action.id}
          keyShortcut={keyShortcut}
          onSelect={onSelect}
          surface={surface}
        />
      ))}
    </div>
  );

  if (scrollLabels === undefined) {
    return group;
  }
  return (
    <HorizontalScroller
      nextLabel={scrollLabels.next}
      previousLabel={scrollLabels.previous}
    >
      {group}
    </HorizontalScroller>
  );
};
