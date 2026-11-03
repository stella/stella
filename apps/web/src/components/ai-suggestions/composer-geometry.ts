/**
 * Shared width for docked composer-adjacent controls. Keep this separate from
 * the rich chat host so document review controls do not pull the composer
 * implementation into the editor bundle just to inherit its geometry.
 */
export const DOCKED_COMPOSER_WIDTH_CLASS = "w-[min(560px,calc(100%-2rem))]";

/**
 * The veil carries up to a 200px feather outside each edge of the 560px
 * composer.
 * Its fully opaque center therefore covers the complete composer/status stack
 * instead of fading through the controls themselves.
 */
export const DOCKED_COMPOSER_VEIL_WIDTH_CLASS =
  "w-[min(960px,calc(100%-0.5rem))]";

/**
 * Inline-start inset of the column the docked composer centres on, read from
 * a CSS custom property the host pane sets. A reader that lays a side column
 * beside its text (the decision page's analysis column) sets it to that
 * column's width so the bar centres on the text, not on the pane; a host
 * that sets nothing centres on the whole pane.
 */
export const DOCKED_COMPOSER_INSET_START_CLASS =
  "start-[var(--docked-composer-inset-start,0px)]";

/**
 * Marks a viewer's scrolling content whose end runs under the docked
 * composer. While the composer floats, `file-viewer-with-ai.css` reserves
 * trailing space on the marked element so the last page or line can scroll
 * fully above the composer stack; anywhere else the marker does nothing.
 * Spread it onto the scrolling content of every viewer `FileViewerWithAI`
 * wraps.
 */
export const DOCKED_COMPOSER_CLEARANCE = {
  "data-docked-composer-clearance": "",
} as const;
