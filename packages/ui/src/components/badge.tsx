import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";

import { cn } from "../lib/utils";
import type { StatusTone } from "./list";

/**
 * A short label that classifies the thing beside it: a status, a type, a
 * count. The words carry the meaning; the tone and the optional dot only
 * reinforce it, so colour is never the sole signal.
 *
 * The tones are the ones `ListItemStatus` uses, plus `info`, so a row that
 * shows a status as a dot and label and a card that shows it as a badge read
 * as the same colour.
 */
function Badge({
  className,
  tone = "neutral",
  size = "sm",
  dot = false,
  children,
  render,
  ...props
}: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ size, tone }), className),
    "data-slot": "badge",
    "data-tone": tone,
    "data-size": size,
    children: (
      <>
        {dot ? (
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              BADGE_DOT_CLASS[tone],
            )}
            data-slot="badge-dot"
          />
        ) : null}
        {children}
      </>
    ),
  };

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

type BadgeTone = StatusTone | "info";

/** `sm` stands on its own beside a title; `xs` sits in a line of meta text. */
type BadgeSize = "xs" | "sm";

type BadgeProps = useRender.ComponentProps<"span"> & {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** A leading dot in the tone's colour, for a status rather than a type. */
  dot?: boolean;
};

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center rounded-md font-medium whitespace-nowrap tabular-nums [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "sm",
      tone: "neutral",
    },
    variants: {
      size: {
        sm: "h-5 gap-1.5 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        xs: "text-2xs h-4 gap-1 px-1.5 [&_svg:not([class*='size-'])]:size-3",
      },
      tone: {
        destructive: "bg-destructive/12 text-destructive-foreground",
        info: "bg-info/12 text-info-foreground",
        neutral: "bg-muted text-muted-foreground",
        success: "bg-success/12 text-success-foreground",
        warning: "bg-warning/12 text-warning-foreground",
      } satisfies Record<BadgeTone, string>,
    },
  },
);

const BADGE_DOT_CLASS = {
  destructive: "bg-destructive",
  info: "bg-info",
  neutral: "bg-foreground-disabled",
  success: "bg-success",
  warning: "bg-warning",
} as const satisfies Record<BadgeTone, string>;

export { Badge, badgeVariants };
export type { BadgeProps, BadgeSize, BadgeTone };
