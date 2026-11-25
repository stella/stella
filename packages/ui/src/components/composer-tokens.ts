// The composer's tokens as plain strings, with no React or DOM: the web's
// composer (./composer.tsx) and the mobile app's both read them, so the two
// boxes cannot drift apart.

/**
 * The tokens a composer's paint shares: the box, its text, its round
 * controls and the rows beside it. The box's layout (where the text sits,
 * where the controls sit, how it grows and scrolls) is not a token: it
 * belongs to `ComposerFrame` (./composer.tsx), and every web composer renders
 * through it, so no surface can lay text and controls out by hand. The
 * mobile app paints its native box from `COMPOSER_BOX_CLASS`.
 */

/** Shared responsive size for the two round controls flanking a composer. */
export const COMPOSER_CONTROL_BUTTON_SIZE = "icon-sm" as const;

/** The bordered box: background, radius, border, colour transition. The
 *  radius is the docked bar's original `rounded-2xl`: at the compact row's
 *  stature it reads as a soft pill, which is the shape the composers were
 *  meant to unify on. */
export const COMPOSER_BOX_CLASS = "bg-background rounded-2xl border";

/**
 * Background for chrome floating over a document page (the docked composer,
 * the suggestion stepper, preset chips). In light mode the rendered page
 * reads as white paper in every accent palette, while `--popover` follows
 * the palette (Flexoki `#fffcf0`, Nord `#eceff4`): solid but visibly
 * hue-tinted against the document. These surfaces are anchored to the
 * document instead: white in light; in dark the page follows the theme, so
 * the popover token stays correct.
 */
export const DOC_FLOAT_SURFACE_CLASS =
  "[--doc-float-surface:var(--color-white)] dark:[--doc-float-surface:var(--popover)] bg-(--doc-float-surface)";

/** Text stature of the editor and every placeholder painted over it. */
export const COMPOSER_TEXT_CLASS = "text-sm leading-5";

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
  "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs";

/**
 * The slim status row under a composer box (`ComposerStatusRow`), with a
 * middle slot: three columns whose sides share the remaining width, so the
 * middle stays centred. A loading view draws the row from the same class.
 */
export const COMPOSER_STATUS_ROW_CENTERED_CLASS =
  "text-muted-foreground @container mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-1 text-xs";

/** The status row without a middle slot: a start cluster and an end slot. */
export const COMPOSER_STATUS_ROW_CLASS =
  "text-muted-foreground mt-1.5 flex items-center justify-between gap-2 px-1 text-xs";
