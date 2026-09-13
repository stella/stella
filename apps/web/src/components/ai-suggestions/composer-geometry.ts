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
