"use client";

import { createContext, use } from "react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_LARGE_ACTION_ROW_CLASS,
  COMPOSER_LARGE_EDITOR_CLASS,
  COMPOSER_LARGE_TEXT_WELL_CLASS,
} from "./composer-tokens";
import { ScrollArea } from "./scroll-area";
import { Skeleton } from "./skeleton";

/**
 * A home screen's one shape: a greeting and a box in the upper fold, three
 * columns of what the reader reaches from it below. The chat home and the
 * law home render from these, so a reader who has learned one has learned
 * the other, and the two cannot drift apart.
 */

// Whether the layout stands in for a page that has not loaded yet. Its
// scroll areas are then plain boxes of the same geometry: nothing in a
// placeholder scrolls, and the server's cold-load paint of it carries no
// generated ids for the browser to hydrate.
const LandingPlaceholderContext = createContext(false);

type LandingScrollProps = {
  children: ReactNode;
  className: string;
  scrollFade?: boolean;
};

const LandingScroll = ({
  children,
  className,
  scrollFade = false,
}: LandingScrollProps) =>
  use(LandingPlaceholderContext) ? (
    // `ScrollArea`'s root and viewport boxes, without the scrolling.
    <div className={cn("flex size-full min-h-0 flex-col", className)}>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[inherit]">
        {children}
      </div>
    </div>
  ) : (
    <ScrollArea className={className} scrollFade={scrollFade}>
      {children}
    </ScrollArea>
  );

type LandingLayoutProps = {
  /** Header-slot actions that belong to the page rather than the fold. */
  actions?: ReactNode | undefined;
  /** The layout stands in for the page while it loads (a pending view). */
  placeholder?: boolean | undefined;
  /** The greeting and the box; centred in the upper fold. */
  hero: ReactNode;
  /** The columns; take the rest of the height, each scrolling on its own. */
  children: ReactNode;
  /** Below the columns, in its own bounded scroll: crawlable navigation. */
  footer?: ReactNode | undefined;
};

export const LandingLayout = ({
  actions,
  placeholder = false,
  hero,
  children,
  footer,
}: LandingLayoutProps) => (
  <LandingPlaceholderContext value={placeholder}>
    <div className="mx-auto flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden">
      {actions}
      {/* The landing folds against its own width, not the viewport's: a side
        pane can leave this column far narrower than a viewport breakpoint
        would suggest. */}
      <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* In one column the page scrolls: the fold leaves a phone too little
          height to split three ways, and each column got a sliver too short
          for one row under its scroll fade. Side by side, the page fills
          the viewport exactly and never scrolls; the columns do. */}
        <LandingScroll className="min-h-0 flex-1">
          <div className="flex min-h-full w-full flex-col items-center px-4 @2xl:h-full">
            {/* The fold prefers 22rem but never ends above the hero's own
              height: a plain flex item's minimum is its content, so a box
              grown by a long paste pushes the columns down instead of
              being clipped, controls and all, under them (a scroll box's
              minimum is zero). The editor caps its own growth and scrolls
              inside. The inline padding leaves room at the sides for the
              box's outer halo (the shield ring, focus rings), which the
              page's viewport clips. */}
            <div className="flex w-full max-w-2xl shrink-0 basis-[22rem] flex-col items-center justify-center gap-8 px-1 @2xl:shrink">
              {hero}
            </div>
            {/* Side by side, the columns share the remaining height; each
              `LandingSection` keeps its heading in place and scrolls its own
              rows, so a long list in one column never pushes another's
              heading out of view. */}
            <div className="grid w-full shrink-0 gap-8 pb-6 @2xl:min-h-0 @2xl:flex-1 @2xl:auto-rows-fr @2xl:grid-cols-3">
              {children}
            </div>
            {footer !== undefined && (
              <LandingScroll
                className="h-auto max-h-[40dvh] w-full shrink-0"
                scrollFade
              >
                {footer}
              </LandingScroll>
            )}
          </div>
        </LandingScroll>
      </div>
    </div>
  </LandingPlaceholderContext>
);

type LandingGreetingProps = {
  /** The mark in the tile: the product mark, or the section's icon. */
  icon: ReactNode;
  /** The one line under the tile, as the page's heading. */
  children: ReactNode;
};

export const LandingGreeting = ({ icon, children }: LandingGreetingProps) => (
  <div className="flex w-full flex-col items-center gap-4 text-center">
    <div className="border-border bg-background text-foreground flex size-12 items-center justify-center rounded-lg border shadow-sm">
      {icon}
    </div>
    <h1 className="text-foreground max-w-md text-center text-lg font-medium">
      {children}
    </h1>
  </div>
);

/** A column's heading: an icon and a sentence-case label, as a link or a trigger. */
export const LANDING_SECTION_HEADING_CLASS =
  "text-foreground hover:bg-accent/50 focus-visible:ring-ring [&>svg]:text-muted-foreground flex items-center gap-2 rounded-md px-2 py-0.5 text-sm font-semibold outline-none focus-visible:ring-2";

/** A row of a column, as a link or a button. Its text lines up with the
 *  heading's label; the icon slot under the heading icon stays empty unless
 *  the icon identifies the row (a matter's colour). */
export const LANDING_ROW_CLASS =
  "group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start outline-none focus-visible:ring-2";

/** A row's box without its interaction: the inset `LANDING_ROW_CLASS` gives. */
const LANDING_ROW_BOX_CLASS = "rounded-md px-2 py-1.5";

const LANDING_ROWS_PENDING_KEYS = ["a", "b", "c"] as const;
const LANDING_ROW_TITLE_WIDTHS = ["w-3/5", "w-4/5", "w-1/2"] as const;
const LANDING_ROW_META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5"] as const;

/** The stack a column's rows sit in (`LandingSection`'s list). */
const LANDING_ROWS_CLASS = "flex flex-col gap-1";

/*
 * The pending pieces of a landing, beside the rows and sections they stand
 * in for. A landing's pending view is its page shell with these in the slots
 * that wait on data (contract: apps/web/src/routes/-route-pending-view.tsx),
 * so nothing moves when the rows land.
 */

/**
 * A column's rows while they load, on a `LandingItemText` row's lines (the
 * empty icon slot, a `text-sm` title over a `text-xs` meta line), so the rows
 * that arrive take the placeholders' place without moving anything. With a
 * `label` the stack is announced as one busy region; without one (inside a
 * pending frame that already announces itself) it is decoration.
 */
export const LandingRowsPending = ({
  label,
}: {
  label?: string | undefined;
}) => (
  <div
    {...(label === undefined
      ? { "aria-hidden": true }
      : { "aria-busy": true, "aria-label": label, role: "status" })}
    className={LANDING_ROWS_CLASS}
  >
    {LANDING_ROWS_PENDING_KEYS.map((key, index) => (
      <div
        aria-hidden="true"
        className={LANDING_ROW_BOX_CLASS}
        data-slot="landing-row-skeleton"
        key={key}
      >
        <div className="flex min-w-0 items-start gap-2">
          <span className="size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex h-5 items-center">
              <Skeleton
                className={cn("h-3.5", LANDING_ROW_TITLE_WIDTHS[index])}
              />
            </div>
            <div className="flex h-4 items-center">
              <Skeleton
                className={cn("h-2.5", LANDING_ROW_META_WIDTHS[index])}
              />
            </div>
          </div>
        </div>
      </div>
    ))}
  </div>
);

/** A column heading whose label is not known yet: its real icon (it needs no
 *  data) and a bar on the label's line, in the heading's own inset. */
export const LandingSectionHeadingPending = ({
  icon,
}: {
  icon?: ReactElement | undefined;
}) => (
  <div
    aria-hidden="true"
    className="[&>svg]:text-muted-foreground flex items-center gap-2 px-2 py-0.5"
  >
    {icon ?? <Skeleton className="size-4 shrink-0" />}
    <div className="flex h-5 items-center">
      <Skeleton className="h-3 w-28" />
    </div>
  </div>
);

/** Which box the hero holds: the chat composer, whose trailing controls sit
 *  on a 38px hit row, or the law entry box, whose single search button is
 *  the (+) trigger's 28px circle. */
export type LandingBox = "composer" | "search";

const BOX_TRAILING_CONTROLS_CLASS = {
  composer: "h-9.5",
  search: "h-7",
} as const satisfies Record<LandingBox, string>;

/**
 * The hero's box before it mounts (the chat composer, the law entry box),
 * from the composer tokens both are built on: the bordered box, the
 * three-line text well, the action row with its round ends, and the status
 * row's line beneath.
 */
export const LandingBoxPending = ({ box }: { box: LandingBox }) => (
  <div aria-hidden="true" className="flex w-full flex-col">
    <div className={COMPOSER_BOX_CLASS}>
      <div className={COMPOSER_LARGE_TEXT_WELL_CLASS}>
        <div className={cn(COMPOSER_LARGE_EDITOR_CLASS, "py-0.5")}>
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
      <div className={COMPOSER_LARGE_ACTION_ROW_CLASS}>
        <Skeleton className="me-auto size-7 rounded-full" />
        <span
          className={cn("flex items-center", BOX_TRAILING_CONTROLS_CLASS[box])}
        >
          <Skeleton className="size-7 rounded-full" />
        </span>
      </div>
    </div>
    <div className="mt-1.5 flex h-6 items-center justify-between gap-2 px-1">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-24" />
    </div>
  </div>
);

type LandingSectionProps = {
  children: ReactNode;
  heading: ReactNode;
};

/** A column: its heading stays put, its rows scroll beneath it. The rows get
 *  the same ring room as the hero box, since the viewport clips a flush row's
 *  focus ring; the heading takes the same inset so the labels stay aligned. */
export const LandingSection = ({ children, heading }: LandingSectionProps) => (
  <section className="flex min-h-0 min-w-0 flex-col">
    <div className="mb-3 shrink-0 px-1">{heading}</div>
    <LandingScroll className="@2xl:min-h-0 @2xl:flex-1" scrollFade>
      <div className={cn(LANDING_ROWS_CLASS, "px-1 pt-1 pb-4")}>{children}</div>
    </LandingScroll>
  </section>
);
