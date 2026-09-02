"use client";

import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * The tokens every composer box shares: the chat hero, the chat follow-up
 * bar, the docked bar over documents (inspector chat, file overlay,
 * Template Studio) and the law home's entry box all render one shell from
 * these, so they restyle together. A surface that needs the look imports
 * these rather than copying the classes; a copy is how the boxes drifted
 * apart the first time (44px / `rounded-lg` / 14px in the chat, 38px /
 * `rounded-2xl` / 13px in the inspector).
 */

/** Shared responsive size for the two round controls flanking a composer. */
export const COMPOSER_CONTROL_BUTTON_SIZE = "icon-sm" as const;

/** The bordered box: background, radius, border, colour transition. The
 *  radius is the docked bar's original `rounded-2xl`: at the compact row's
 *  stature it reads as a soft pill, which is the shape the composers were
 *  meant to unify on. */
export const COMPOSER_BOX_CLASS =
  "bg-background rounded-2xl border transition-colors";

/** The box's focus ring in its default (non-anonymized) treatment. */
export const COMPOSER_BOX_FOCUS_CLASS = "focus-within:border-ring";

/**
 * The box's "shield active" treatment when the next send is anonymized: a
 * blue ring replaces the default focus border (both together read as a
 * double ring on click).
 */
export const COMPOSER_BOX_ANONYMIZED_CLASS =
  "ring-info/40 border-info/40 focus-within:border-info/60 shadow-[0_0_0_4px_rgb(from_var(--color-info)_r_g_b_/_0.08)] ring-1";

/**
 * The compact (one-line) bar row: its stature, end alignment, control gap
 * and inset. The surface supplies the layout (`grid` for the chat bar's
 * three fixed columns, `flex` for the docked bar's variable leading
 * controls); the row grows with the editor.
 */
export const COMPOSER_COMPACT_ROW_CLASS =
  "min-h-11 items-end gap-1 px-1.5 py-px";

/**
 * The compact text cell: one `text-sm` line at `leading-5` plus the
 * vertical inset that makes a single line exactly as tall as the row's
 * inner height (44px row, 1px inset each side ⇒ 42px), so text and controls
 * share one centre. The editable element itself takes `min-h-0` so an empty
 * composer collapses to this one line and grows from there.
 */
export const COMPOSER_COMPACT_TEXT_CELL_CLASS = "relative min-w-0 py-[11px]";

/** Text stature of the editor and every placeholder painted over it. */
export const COMPOSER_TEXT_CLASS = "text-sm leading-5";

/**
 * The `large` (hero) text well: the padding around the editor. The editor's
 * own stature is `COMPOSER_LARGE_EDITOR_CLASS` (~3 lines of `text-sm` at
 * `leading-5`), applied on the editable element by each surface because the
 * chat editor targets its `.ProseMirror` node while a plain textarea takes
 * it directly.
 */
export const COMPOSER_LARGE_TEXT_WELL_CLASS = "ps-3 pe-3 pt-2 pb-1";

/** The `large` editable element's stature: three lines before it grows. */
export const COMPOSER_LARGE_EDITOR_CLASS = "min-h-15";

/** The placeholder painted over an empty editor, in either stature. */
export const COMPOSER_PLACEHOLDER_CLASS =
  "text-foreground-placeholder pointer-events-none absolute truncate text-sm";

/** The `large` action row under the text well: leading controls, trailing send. */
export const COMPOSER_LARGE_ACTION_ROW_CLASS =
  "flex items-center justify-end gap-0.5 px-1.5 pb-1.5";

/** The leading group of the action row (the (+) menu, or a scope control). */
export const COMPOSER_LEADING_GROUP_CLASS = "flex min-w-0 items-center gap-0.5";

/**
 * The round, foreground-filled primary control at the action row's end:
 * the chat's send/stop/retry button and the law home's submit. `size-7`
 * pins the circle to the (+) trigger's diameter at every breakpoint
 * (`icon-sm` alone is 32px below `sm`), so a row's two round ends match.
 */
export const COMPOSER_SEND_BUTTON_CLASS =
  "bg-foreground text-background hover:bg-foreground/90 size-7 shrink-0 rounded-full";

/**
 * A picker in the status row under the box (the chat's matter picker, the
 * law home's scope and jurisdiction): quiet text with a hover surface, so
 * the row stays subordinate to the box above it.
 */
export const COMPOSER_PICKER_TRIGGER_CLASS =
  "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors";

type ComposerStatusRowProps = {
  /** Left cluster: matter picker, web-search / anonymize toggles, ... */
  start?: ReactNode | undefined;
  /** End slot, pinned to the far edge (e.g. the context meter). */
  end?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * The slim status row rendered beneath a composer box: a `text-xs` row with
 * a start cluster and an end slot pinned to the far edge. Shared by every
 * surface so the shell can never drift. Renders nothing when both slots are
 * empty, so a surface with no per-send controls shows no row.
 */
export const ComposerStatusRow = ({
  start,
  end,
  className,
}: ComposerStatusRowProps) => {
  if (start === undefined && end === undefined) {
    return null;
  }

  return (
    <div
      className={cn(
        "text-muted-foreground mt-1.5 flex items-center justify-between gap-2 px-1 text-xs",
        className,
      )}
    >
      {start}
      {end !== undefined && <div className="ms-auto">{end}</div>}
    </div>
  );
};
