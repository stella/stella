"use client";

import type * as React from "react";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

/**
 * Grouped list: a titled section holding one surface of hairline-divided
 * rows. Use it for settings and inventories of named things (connections,
 * sessions, members, keys) where each row is icon + name + one quiet line +
 * trailing status or action. Rows never scroll sideways: the content column
 * truncates and the trailing column keeps its width, so actions stay on
 * screen at any viewport.
 */
const ListGroup = ({
  className,
  ...props
}: React.ComponentProps<"section">) => (
  <section
    className={cn("flex flex-col gap-2.5", className)}
    data-slot="list-group"
    {...props}
  />
);

const ListGroupHeader = ({
  className,
  ...props
}: React.ComponentProps<"header">) => (
  <header
    className={cn("flex items-end gap-4 px-1", className)}
    data-slot="list-group-header"
    {...props}
  />
);

/** Title and description stack; takes the space the header action leaves. */
const ListGroupHeading = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
    data-slot="list-group-heading"
    {...props}
  />
);

const ListGroupTitle = ({
  className,
  children,
  ...props
}: React.ComponentProps<"h2">) => (
  <h2
    className={cn(
      "text-foreground text-sm font-medium text-balance",
      className,
    )}
    data-slot="list-group-title"
    {...props}
  >
    {children}
  </h2>
);

/** Quiet item count after the title; shows matches while a search filters. */
const ListGroupCount = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn(
      "text-muted-foreground ms-1.5 font-normal tabular-nums",
      className,
    )}
    data-slot="list-group-count"
    {...props}
  />
);

const ListGroupDescription = ({
  className,
  ...props
}: React.ComponentProps<"p">) => (
  <p
    className={cn("text-muted-foreground text-xs text-pretty", className)}
    data-slot="list-group-description"
    {...props}
  />
);

/** Quiet trailing affordance on the header row (a link or ghost button). */
const ListGroupAction = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex shrink-0 items-center gap-1", className)}
    data-slot="list-group-action"
    {...props}
  />
);

/** The surface. Depth comes from a ring plus a soft shadow, not a frame. */
const List = ({ className, ...props }: React.ComponentProps<"ul">) => (
  <ul
    className={cn(
      "bg-background ring-border divide-border flex flex-col divide-y overflow-hidden rounded-xl shadow-xs/5 ring-1",
      className,
    )}
    data-slot="list"
    {...props}
  />
);

/**
 * One row. Pass `render` (a link or button element) to make the whole row the
 * target; then keep other interactive elements out of it. Rows with their own
 * trailing buttons stay a plain `li` and put the actions in `ListItemActions`.
 */
const ListItem = ({
  className,
  render,
  children,
  ...props
}: useRender.ComponentProps<"div">) => {
  const defaultProps = {
    className: cn(
      "flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start",
      render !== undefined &&
        "hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset",
      className,
    ),
    "data-slot": "list-item",
    children,
  };
  const row = useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(defaultProps, props),
    render,
  });
  // The `li` carries the divider; the row inside it carries layout and focus.
  return <li className="flex">{row}</li>;
};

const listItemMediaVariants = cva(
  "bg-muted grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10",
  {
    defaultVariants: { variant: "icon" },
    variants: {
      variant: {
        /** A glyph or logo, drawn quietly. */
        icon: "text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
        /** A letter standing in for a name that has no logo. */
        initial: "text-foreground text-xs font-medium",
      },
    },
  },
);

/** Fixed 32px tile for an icon, logo or initial. */
const ListItemMedia = ({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof listItemMediaVariants>) => (
  <div
    aria-hidden="true"
    className={cn(listItemMediaVariants({ variant }), className)}
    data-slot="list-item-media"
    {...props}
  />
);

const ListItemContent = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
    data-slot="list-item-content"
    {...props}
  />
);

const ListItemTitle = ({
  className,
  ...props
}: React.ComponentProps<"span">) => (
  <span
    className={cn("text-foreground truncate text-sm font-medium", className)}
    data-slot="list-item-title"
    dir="auto"
    {...props}
  />
);

const listItemDescriptionVariants = cva("text-muted-foreground text-xs", {
  defaultVariants: { variant: "text" },
  variants: {
    variant: {
      /** Prose, clamped to one line so long provider copy cannot widen the row. */
      text: "line-clamp-1 wrap-break-word",
      /** A URL or command: monospace, left-to-right, truncated at the end. */
      code: "truncate font-mono",
    },
  },
});

/**
 * Secondary line. Pass `line-clamp-2` when two lines are genuinely needed;
 * never `whitespace-nowrap`.
 */
const ListItemDescription = ({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof listItemDescriptionVariants>) => (
  <span
    className={cn(listItemDescriptionVariants({ variant }), className)}
    data-slot="list-item-description"
    dir={variant === "code" ? "ltr" : "auto"}
    {...props}
  />
);

const ListItemActions = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex shrink-0 items-center gap-2", className)}
    data-slot="list-item-actions"
    {...props}
  />
);

/** Single-line empty row inside a `List`. Phrase it as the next action. */
const ListEmpty = ({ className, ...props }: React.ComponentProps<"li">) => (
  <li
    className={cn(
      "text-muted-foreground flex min-h-14 items-center gap-2 px-4 py-2.5 text-sm",
      className,
    )}
    data-slot="list-empty"
    {...props}
  />
);

type StatusTone = "neutral" | "success" | "warning" | "destructive";

const STATUS_DOT_CLASS = {
  neutral: "bg-foreground-disabled",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
} as const satisfies Record<StatusTone, string>;

/**
 * Dot + label status. The label always carries the meaning; the dot only
 * reinforces it, so colour is never the sole signal.
 */
const ListItemStatus = ({
  tone = "neutral",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: StatusTone }) => (
  <span
    className={cn(
      "text-muted-foreground inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
      className,
    )}
    data-slot="list-item-status"
    data-tone={tone}
    {...props}
  >
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[tone])}
    />
    {children}
  </span>
);

export {
  List,
  ListEmpty,
  ListGroup,
  ListGroupAction,
  ListGroupCount,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
};
export type { StatusTone };
