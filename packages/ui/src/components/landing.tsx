"use client";

import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/utils";
import { BidiText } from "./bidi-text";
import { ScrollArea } from "./scroll-area";

/**
 * A home screen's one shape: a greeting and a box in the upper fold, three
 * columns of what the reader reaches from it below. The chat home and the
 * law home render from these, so a reader who has learned one has learned
 * the other, and the two cannot drift apart.
 */

type LandingLayoutProps = {
  /** Header-slot actions that belong to the page rather than the fold. */
  actions?: ReactNode | undefined;
  /** The greeting and the box; centred in the upper fold. */
  hero: ReactNode;
  /** The columns; take the rest of the height, each scrolling on its own. */
  children: ReactNode;
  /** Below the columns, in its own bounded scroll: crawlable navigation. */
  footer?: ReactNode | undefined;
};

export const LandingLayout = ({
  actions,
  hero,
  children,
  footer,
}: LandingLayoutProps) => (
  <div className="mx-auto flex h-full w-full max-w-5xl flex-1 flex-col overflow-hidden">
    {actions}
    {/* The landing folds against its own width, not the viewport's: a side
        pane can leave this column far narrower than a viewport breakpoint
        would suggest. */}
    <div className="@container flex min-h-0 flex-1 flex-col items-center overflow-hidden px-4">
      {/* The box may grow past the preferred fold height; keep every one
          of its controls reachable without making the whole page scroll. */}
      <ScrollArea
        className="min-h-72 w-full max-w-2xl shrink basis-[22rem]"
        scrollFade
      >
        <div className="flex min-h-full w-full flex-col items-center justify-center gap-8">
          {hero}
        </div>
      </ScrollArea>
      {/* The columns share the remaining height; each `LandingSection`
          keeps its heading in place and scrolls its own rows, so a long list
          in one column never pushes another's heading out of view. */}
      <div className="grid min-h-0 w-full flex-1 auto-rows-fr gap-8 pb-6 @2xl:grid-cols-3">
        {children}
      </div>
      {footer !== undefined && (
        <ScrollArea className="h-auto max-h-[40vh] w-full shrink-0" scrollFade>
          {footer}
        </ScrollArea>
      )}
    </div>
  </div>
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

/** A column's heading: an icon and an uppercase label, as a link or a trigger. */
export const LANDING_SECTION_HEADING_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2";

/** A row of a column, as a link or a button. */
export const LANDING_ROW_CLASS =
  "group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2";

type LandingSectionProps = {
  children: ReactNode;
  heading: ReactNode;
};

/** A column: its heading stays put, its rows scroll beneath it. */
export const LandingSection = ({ children, heading }: LandingSectionProps) => (
  <section className="flex min-h-0 min-w-0 flex-col">
    <div className="mb-3 shrink-0">{heading}</div>
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="flex flex-col gap-1 pb-4">{children}</div>
    </ScrollArea>
  </section>
);

type LandingButtonProps = {
  icon?: ReactElement;
  meta?: ReactNode | undefined;
  onClick: () => void;
  title: ReactNode;
};

export const LandingButton = ({
  icon,
  meta,
  onClick,
  title,
}: LandingButtonProps) => (
  <button className={LANDING_ROW_CLASS} onClick={onClick} type="button">
    <LandingItemText
      {...(icon === undefined ? {} : { icon })}
      meta={meta}
      title={title}
    />
  </button>
);

type LandingItemTextProps = {
  icon?: ReactElement;
  iconTone?: "muted" | "matter" | undefined;
  meta?: ReactNode | undefined;
  title: ReactNode;
};

export const LandingItemText = ({
  icon,
  iconTone = "muted",
  meta,
  title,
}: LandingItemTextProps) => (
  <span className="flex min-w-0 items-start gap-2">
    {icon !== undefined && (
      <LandingRowIcon tone={iconTone}>{icon}</LandingRowIcon>
    )}
    <span className="min-w-0 flex-1">
      <BidiText
        as="span"
        className="text-foreground block truncate text-sm font-medium"
      >
        {title}
      </BidiText>
      {meta !== undefined && meta !== null ? (
        <span className="text-muted-foreground block truncate text-xs">
          {meta}
        </span>
      ) : null}
    </span>
  </span>
);

type LandingRowIconProps = {
  children: ReactElement;
  tone?: "muted" | "matter" | undefined;
};

export const LandingRowIcon = ({
  children,
  tone = "muted",
}: LandingRowIconProps) => (
  <span
    className={cn(
      "mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors",
      tone === "muted" &&
        "text-foreground-muted group-hover:text-muted-foreground",
    )}
  >
    {children}
  </span>
);

type LandingEmptyProps = {
  children: ReactNode;
};

export const LandingEmpty = ({ children }: LandingEmptyProps) => (
  <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
    {children}
  </div>
);
