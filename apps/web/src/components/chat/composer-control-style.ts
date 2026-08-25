/**
 * The tokens every composer box shares: the chat hero, the chat follow-up
 * bar, and the docked bar over documents (inspector chat, file overlay,
 * Template Studio) all render one shell from these, so they restyle
 * together. A surface that needs the look imports these rather than copying
 * the classes; a copy is how the boxes drifted apart the first time (44px /
 * `rounded-lg` / 14px in the chat, 38px / `rounded-2xl` / 13px in the
 * inspector).
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
 * A round control's slot in the compact row: as tall as the row's inner
 * height, with the control centred in it. In a one-line row that centres
 * the control on the text; as the editor grows the row's `items-end` keeps
 * the slot on the last line, where the control stays centred on that line.
 */
export const COMPOSER_COMPACT_CONTROL_SLOT_CLASS =
  "flex h-[calc(--spacing(11)-2px)] shrink-0 items-center";

/**
 * The `large` (hero) text well: the padding around the editor. The editor's
 * own stature is `min-h-15` (~3 lines of `text-sm` at `leading-5`), applied
 * on the editable element by each surface because the chat editor targets its
 * `.ProseMirror` node while a plain textarea takes it directly.
 */
export const COMPOSER_LARGE_TEXT_WELL_CLASS = "ps-3 pe-3 pt-2 pb-1";

/** The placeholder painted over an empty editor, in either stature. */
export const COMPOSER_PLACEHOLDER_CLASS =
  "text-foreground-placeholder pointer-events-none absolute truncate text-sm";

/** The `large` action row under the text well: leading controls, trailing send. */
export const COMPOSER_LARGE_ACTION_ROW_CLASS =
  "flex items-center justify-end gap-0.5 px-1.5 pb-1.5";

/** The leading group of the action row (the (+) menu, or a scope control). */
export const COMPOSER_LEADING_GROUP_CLASS = "flex min-w-0 items-center gap-0.5";
