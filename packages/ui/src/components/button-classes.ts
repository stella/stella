// The web button's classes, with no React or Base UI: the button
// (./button.tsx) builds its variants from them, and a loading view draws a
// button's face (./control-face.tsx) from the same classes, so the face in a
// pending view and the button that replaces it share one box.

import { TOOLBAR_ROW_HEIGHT } from "../inspector/layout-tokens";
import {
  BUTTON_VARIANT_TOKENS,
  type ButtonSize,
  type ButtonTokenVariant,
} from "./button.shared";

/** Every size but a menu row, which only a real button takes. */
export type ButtonFaceSize = Exclude<ButtonSize, "row">;

/** The box every sized button shares: layout, border, type, focus ring. */
export const BUTTON_BASE_CLASS =
  "focus-visible:ring-ring focus-visible:ring-offset-background relative inline-flex max-w-full shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border text-base font-medium whitespace-nowrap outline-none select-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-64 sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4";

export const BUTTON_DEFAULT_SIZE = "default";

/** A variant's shared colours (./button.shared.ts), before the web's states. */
const tokens = (variant: ButtonTokenVariant): string => {
  const { surface, label } = BUTTON_VARIANT_TOKENS[variant];
  return label === "" ? surface : `${surface} ${label}`;
};

/**
 * Every shared size (./button.shared.ts) in the web's metrics, but `row`:
 * a menu row's metric belongs to the menu module, and the button adds it.
 */
export const BUTTON_FACE_SIZE_CLASS_NAMES = {
  // Pill chip beside a composer: pinned to the composer's round
  // controls (28px at every breakpoint) so a chip row and the control
  // row below it share one scale. Text stays `text-xs` at every
  // breakpoint for the same reason.
  chip: "h-7 gap-1.5 rounded-full px-2.5 text-xs before:rounded-full sm:text-xs",
  default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
  icon: "size-9 sm:size-8",
  "icon-lg": "size-10 sm:size-9",
  "icon-round": "size-7 rounded-full sm:size-7",
  "icon-sm": "size-8 sm:size-7",
  "icon-xl":
    "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
  // The smallest square: a glyph-sized action inside a dense row (a
  // margin note's edit and delete, a tree's disclosure chevron). Its
  // touch target still grows to 44px under a coarse pointer.
  "icon-2xs":
    "size-5 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-4 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3",
  "icon-xs":
    "size-7 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
  // A short action that sits in a line of text: a "show more", a
  // paragraph reference, an inline edit. It draws no box of its own (no
  // height, padding or type size) and takes the font of the line around
  // it, so swapping a word for an action leaves the line as it was. Its
  // variant still owns colour, focus and the selected treatment; see
  // compoundVariants for the hover fill it does not paint.
  // A <button> stays one atomic box even at `display: inline`: its label
  // never breaks across the paragraph's lines. A label too long for the
  // line moves to the next one whole and wraps inside its own box, so it
  // never overflows; text that has to flow with the prose (a citation in
  // reader text) is a `ButtonTextRun`.
  inline:
    "inline h-auto rounded-sm border-0 p-0 text-start text-[length:inherit] leading-[inherit] font-normal whitespace-normal select-text before:rounded-[calc(var(--radius-sm)-1px)] sm:text-[length:inherit] [&_svg]:mx-0 [&_svg]:inline [&_svg]:align-[-0.125em] [&_svg:not(:last-child)]:me-1",
  "inspector-row": `${TOOLBAR_ROW_HEIGHT} justify-start rounded-none px-3`,
  lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
  // Small controls read in small type; `SelectTrigger` and `Input`
  // share the height, so a toolbar of `sm` controls shares one scale.
  sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] text-sm sm:h-7 sm:text-xs",
  touch: "min-h-[44px] min-w-[44px] px-[calc(--spacing(3.5)-1px)]",
  xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
  xs: "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-sm before:rounded-[calc(var(--radius-md)-1px)] sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
} as const satisfies Record<ButtonFaceSize, string>;

// Every shared variant: its shared colours, then the web's states. A
// selected button (`data-pressed`) shows its own treatment, and hover never
// paints over it.
export const BUTTON_PRIMARY_STATE_CLASS =
  "shadow-primary/24 data-pressed:bg-primary/80 [:hover:not([data-pressed])]:bg-primary/90 shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none";

export const BUTTON_VARIANT_CLASS_NAMES = {
  composer: `${tokens("composer")} ${BUTTON_PRIMARY_STATE_CLASS} hover:bg-foreground/90`,
  default: `${tokens("default")} ${BUTTON_PRIMARY_STATE_CLASS}`,
  destructive: `${tokens("destructive")} shadow-destructive/8 data-pressed:border-destructive/56 data-pressed:bg-destructive/20 [:hover:not([data-pressed])]:border-destructive/40 [:hover:not([data-pressed])]:bg-destructive/14 active:bg-destructive/18 shadow-xs not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] [:disabled,:active,[data-pressed]]:shadow-none`,
  "destructive-outline": `${tokens("destructive-outline")} dark:bg-input/32 data-pressed:border-destructive/56 data-pressed:bg-destructive/8 [:hover:not([data-pressed])]:border-destructive/32 [:hover:not([data-pressed])]:bg-destructive/4 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none`,
  "destructive-ghost": `${tokens("destructive-ghost")} data-pressed:bg-destructive/14 data-pressed:inset-ring-destructive/32 [:hover:not([data-pressed])]:bg-destructive/10 data-pressed:inset-ring`,
  ghost: `${tokens("ghost")} data-pressed:bg-accent data-pressed:inset-ring-input [:hover:not([data-pressed])]:bg-accent data-pressed:shadow-xs/5 data-pressed:inset-ring`,
  link: `${tokens("link")} underline-offset-4 data-pressed:underline data-pressed:decoration-2 [:hover:not([data-pressed])]:underline`,
  // Quiet until hovered, then destructive: a delete beside quiet actions.
  "muted-destructive": `${tokens("muted-destructive")} data-pressed:bg-destructive/14 data-pressed:text-destructive data-pressed:inset-ring-destructive/32 [:hover:not([data-pressed])]:bg-destructive/10 [:hover:not([data-pressed])]:text-destructive data-pressed:inset-ring`,
  // Quiet action: muted until hovered, then the ghost treatment.
  muted: `${tokens("muted")} data-pressed:bg-accent data-pressed:text-foreground data-pressed:inset-ring-input [:hover:not([data-pressed])]:bg-accent [:hover:not([data-pressed])]:text-foreground data-pressed:shadow-xs/5 data-pressed:inset-ring`,
  outline: `${tokens("outline")} dark:bg-input/32 data-pressed:border-primary/48 data-pressed:bg-accent dark:data-pressed:bg-input/64 [:hover:not([data-pressed])]:bg-accent/50 dark:[:hover:not([data-pressed])]:bg-input/64 shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none`,
  secondary: `${tokens("secondary")} data-pressed:bg-background data-pressed:inset-ring-input active:bg-secondary/80 [:hover:not([data-pressed])]:bg-secondary/90 data-pressed:shadow-xs/5 data-pressed:inset-ring`,
} as const satisfies Record<ButtonTokenVariant, string>;

// How a web button lays out its label: `wrap` lets a long label take several
// lines in a full-width row instead of overflowing a fixed height.
export const BUTTON_LAYOUT_CLASS_NAMES = {
  wrap: "h-auto min-h-11 items-start justify-start py-2 text-start whitespace-normal sm:h-auto",
} as const;
