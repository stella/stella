"use client";

import type * as React from "react";

import { cn } from "../lib/utils";
import { Skeleton, SkeletonInline } from "./skeleton";

/*
 * The grouped list's shell (./list.tsx): the group, its header and title, and
 * the surface the rows sit on, with no Base UI and no popup, so a loading
 * view drawn before the app's providers mount renders the list it stands in
 * for. The rows that load replace `ListItemSkeleton`s at their geometry.
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

/** The group's one quiet line under its title. */
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

/**
 * The surface. Depth comes from a ring plus a soft shadow, not a frame.
 *
 * A row wrapped in `EntityActions` sits inside its `display: contents`
 * listener, which draws no border, and its menu anchor follows it as a
 * sibling, so `divide-y` cannot reach it: such a row draws its own hairline
 * on top, from the second wrapped row on.
 */
const List = ({ className, ...props }: React.ComponentProps<"ul">) => (
  <ul
    className={cn(
      "bg-background ring-border divide-border flex flex-col divide-y overflow-hidden rounded-xl shadow-xs/5 ring-1",
      "[&>[data-slot=entity-actions]~[data-slot=entity-actions]>*]:border-border [&>[data-slot=entity-actions]~[data-slot=entity-actions]>*]:border-t",
      className,
    )}
    data-slot="list"
    {...props}
  />
);

/** A row's box: its height floor, inset and the gap between its slots. */
export const LIST_ITEM_ROW_CLASS =
  "flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-start";

const LIST_ITEM_TITLE_WIDTHS = ["w-56", "w-44", "w-64", "w-48"] as const;
const LIST_ITEM_DESCRIPTION_WIDTHS = ["w-40", "w-32", "w-36", "w-28"] as const;

type ListItemSkeletonProps = {
  /** Which placeholder row this is: the widths vary row to row. */
  index: number;
  /** A 32px `ListItemMedia` tile before the text. */
  media?: boolean | undefined;
  /** A `ListItemDescription` line under the title. */
  description?: boolean | undefined;
  /** The trailing slot (a date, a status), as wide as its placeholder. */
  trailing?: "text" | undefined;
};

/**
 * A `ListItem` while its data loads: the row's box, and a bar on each line
 * the row will hold (a `text-sm` title, a `text-xs` description, the
 * trailing text), so the row that arrives takes its place without moving
 * anything. Decoration: the loading view announces itself once.
 */
const ListItemSkeleton = ({
  description = true,
  index,
  media = false,
  trailing,
}: ListItemSkeletonProps) => (
  <li aria-hidden="true" className="flex" data-slot="list-item-skeleton">
    <div className={LIST_ITEM_ROW_CLASS}>
      {media && <Skeleton className="size-8 shrink-0 rounded-lg" />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex h-5 items-center">
          <Skeleton
            className={cn(
              "h-3.5 max-w-full",
              LIST_ITEM_TITLE_WIDTHS[index % LIST_ITEM_TITLE_WIDTHS.length],
            )}
          />
        </span>
        {description && (
          <span className="flex h-4 items-center">
            <Skeleton
              className={cn(
                "h-3 max-w-full",
                LIST_ITEM_DESCRIPTION_WIDTHS[
                  index % LIST_ITEM_DESCRIPTION_WIDTHS.length
                ],
              )}
            />
          </span>
        )}
      </div>
      {trailing === "text" && (
        <span className="flex h-4 shrink-0 items-center">
          <Skeleton className="h-3 w-12" />
        </span>
      )}
    </div>
  </li>
);

/** A group title whose text waits on data: a bar on the title's line. */
const ListGroupTitlePending = () => (
  <span
    aria-hidden="true"
    className="flex h-5 items-center"
    data-slot="list-group-title-skeleton"
  >
    <SkeletonInline className="h-3.5 w-24" />
  </span>
);

export {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListGroupTitlePending,
  ListItemSkeleton,
};
