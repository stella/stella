/**
 * One row metric for a menu list: a 32px row for a fine pointer that grows to
 * the 44px touch target DESIGN.md asks for under a coarse one, an 8px inset,
 * and small type with a 16px leading icon or checkbox at every breakpoint,
 * against the 18px an unsized icon and the `Checkbox` would otherwise take
 * below `sm`.
 *
 * `Button size="row"` and `CommandItem size="row"` are both built from this
 * constant, so a list that mixes a button row with a highlightable command row
 * cannot drift into two densities.
 */
export const MENU_ROW_CLASS_NAME =
  "min-h-8 w-full min-w-0 justify-start gap-2 px-2 py-1 pointer-coarse:min-h-11 text-start text-sm sm:text-sm [&_[data-slot=checkbox]]:size-4 [&_[data-slot=checkbox]_svg]:size-3 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-4";
