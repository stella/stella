/**
 * Shared width for docked composer-adjacent controls. Keep this separate from
 * the rich chat host so document review controls do not pull the composer
 * implementation into the editor bundle just to inherit its geometry.
 */
export const DOCKED_COMPOSER_WIDTH_CLASS = "w-[min(560px,calc(100%-2rem))]";
