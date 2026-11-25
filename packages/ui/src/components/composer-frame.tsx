"use client";

import { useCallback } from "react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils";
import type {
  ComposerFrameContract,
  ComposerLayout,
  ComposerRing,
} from "./composer-frame.shared";
import { useComposerLayout } from "./composer-layout";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_TEXT_CLASS,
  COMPOSER_TEXT_REGION_MAX_HEIGHT_CLASS,
  DOC_FLOAT_SURFACE_CLASS,
} from "./composer-tokens";
import { ScrollArea } from "./scroll-area";

// The composer box, apart from the status-row pieces in ./composer.tsx: it
// imports no menu or popup, so a route's loading view can draw the same box
// the live composer renders through.

/**
 * One grid for both layouts; only the cells' placement changes, so a switch
 * never remounts the text slot (an editor would lose its focus and
 * selection). The stacked action row leaves its middle column empty.
 */
const COMPOSER_GRID_CLASS = {
  bar: "grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-1 px-1.5 py-px",
  stacked: "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-0.5",
} as const satisfies Record<ComposerLayout, string>;

/**
 * The text cell. In the bar its block inset makes one `leading-5` line
 * exactly the row's inner height (44px row, 1px inset each side, 42px), so
 * text and controls share one centre. Stacked, it spans the box with no
 * inline-end inset, so the scroll region and its scrollbar reach the box's
 * edge.
 */
const COMPOSER_TEXT_CELL_CLASS = {
  bar: "col-start-2 row-start-1 min-w-0 py-[11px]",
  stacked: "col-span-3 row-start-1 min-w-0 ps-3.5 pt-2 pb-1",
} as const satisfies Record<ComposerLayout, string>;

/**
 * The text inside the scroll region. Stacked, its inline-end inset keeps the
 * text 10px clear of the scrollbar, which the scroll area draws 6px wide and
 * 4px inside the box's edge.
 */
const COMPOSER_TEXT_CONTENT_CLASS = {
  bar: "",
  stacked: "pe-5",
} as const satisfies Record<ComposerLayout, string>;

/** Where each control group sits, in each layout. */
const COMPOSER_LEADING_SEAT_CLASS = {
  bar: "col-start-1 row-start-1 h-[calc(--spacing(11)-2px)] self-end",
  stacked: "col-start-1 row-start-2 ps-1.5 pb-1.5",
} as const satisfies Record<ComposerLayout, string>;

const COMPOSER_TRAILING_SEAT_CLASS = {
  bar: "col-start-3 row-start-1 h-[calc(--spacing(11)-2px)] self-end",
  stacked: "col-start-3 row-start-2 pe-1.5 pb-1.5",
} as const satisfies Record<ComposerLayout, string>;

/** A control group's own layout, in either seat. */
const COMPOSER_CONTROL_GROUP_CLASS =
  "flex min-w-0 shrink-0 items-center gap-0.5";

/** The large box's three-line height, on the editable element itself, so a
 *  click anywhere in it lands in the editor. */
const COMPOSER_LARGE_TEXT_CLASS =
  "min-h-15 [&_[role=textbox]]:min-h-15 [&_textarea]:min-h-15";

const COMPOSER_RING_CLASS = {
  none: "",
  focus: "focus-within:border-ring",
  // The next send is anonymized: a blue ring replaces the default focus
  // border (both together read as a double ring on click).
  anonymized:
    "ring-info/40 border-info/40 focus-within:border-info/60 shadow-[0_0_0_4px_rgb(from_var(--color-info)_r_g_b_/_0.08)] ring-1",
  // A transient pulse that points someone at the box.
  attention: "border-primary ring-primary/40 ring-4",
} as const satisfies Record<ComposerRing, string>;

/** What the box sits on. */
type ComposerSurface = "page" | "document";

const COMPOSER_SURFACE_CLASS = {
  page: "",
  // Floating over a document: a shadow ring and the document's own paper.
  document: cn("shadow-floating-ring", DOC_FLOAT_SURFACE_CLASS),
} as const satisfies Record<ComposerSurface, string>;

type ComposerFrameProps = Omit<
  ComponentProps<"div">,
  "children" | "className"
> &
  ComposerFrameContract & {
    /** Painted over the start of the text while given, one line tall; its
     *  content cuts itself to the line. The surface decides when it shows.
     *  A phone's text field draws its own placeholder, so the native frame
     *  has no such slot. */
    placeholder?: ReactNode;
    surface?: ComposerSurface | undefined;
  };

/**
 * The one composer box. Every web composer (the chat bar and hero, the
 * docked bar over documents, the law entry box, the Outlook assistant)
 * renders through it. It owns the box, the bar/stacked layout and the
 * switch between them, and the text's scroll region (its height cap, its
 * edge scrollbar, its fades), so no surface lays text and controls out by
 * hand and no control ever covers text.
 */
export const ComposerFrame = ({
  above,
  attachments,
  empty,
  leading,
  placeholder,
  ring,
  stature,
  surface = "page",
  text,
  trailing,
  ...boxProps
}: ComposerFrameProps) => {
  const { layout, measured } = useComposerLayout(stature, empty);

  // The text's real height against one line of it (./composer-layout.ts).
  const measureText = useCallback(
    (content: HTMLDivElement | null) => {
      if (content === null) {
        return undefined;
      }
      const observer = new ResizeObserver(() => {
        // The ruler is one empty line in the text's own type, so its height
        // is the line height in pixels at any font size, with nothing to
        // parse.
        const ruler = content.querySelector<HTMLElement>(
          '[data-slot="composer-line-ruler"]',
        );
        const lineHeight = ruler?.offsetHeight ?? 0;
        if (lineHeight > 0) {
          measured(content.clientHeight, lineHeight);
        }
      });
      observer.observe(content);
      return () => {
        observer.disconnect();
      };
    },
    [measured],
  );

  return (
    <div
      data-slot="composer-frame"
      {...boxProps}
      className={cn(
        COMPOSER_BOX_CLASS,
        "relative",
        COMPOSER_RING_CLASS[ring],
        COMPOSER_SURFACE_CLASS[surface],
      )}
      data-composer-layout={layout}
    >
      {above}
      {attachments !== undefined && (
        <div data-slot="composer-attachments">{attachments}</div>
      )}
      <div className={COMPOSER_GRID_CLASS[layout]}>
        <div className={COMPOSER_TEXT_CELL_CLASS[layout]}>
          <ScrollArea
            axis="vertical"
            className={COMPOSER_TEXT_REGION_MAX_HEIGHT_CLASS}
            data-slot="composer-text-region"
            scrollFade
          >
            <div
              className={cn(
                // One line tall even before the editor mounts, so the bar
                // keeps its 44px and the placeholder its line.
                "relative min-h-5 wrap-anywhere",
                COMPOSER_TEXT_CLASS,
                COMPOSER_TEXT_CONTENT_CLASS[layout],
                stature === "large" && COMPOSER_LARGE_TEXT_CLASS,
              )}
              data-slot="composer-text"
              ref={measureText}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none invisible absolute start-0 top-0"
                data-slot="composer-line-ruler"
              >
                {"\u200B"}
              </span>
              {text}
              {placeholder !== undefined && (
                <div className="text-foreground-placeholder pointer-events-none absolute inset-x-0 top-0 flex h-5 min-w-0 items-center gap-2">
                  {placeholder}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
        <div
          className={cn(
            COMPOSER_CONTROL_GROUP_CLASS,
            COMPOSER_LEADING_SEAT_CLASS[layout],
          )}
          data-slot="composer-leading"
        >
          {leading}
        </div>
        <div
          className={cn(
            COMPOSER_CONTROL_GROUP_CLASS,
            COMPOSER_TRAILING_SEAT_CLASS[layout],
          )}
          data-slot="composer-trailing"
        >
          {trailing}
        </div>
      </div>
    </div>
  );
};
