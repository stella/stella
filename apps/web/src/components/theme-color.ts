import { THEME_COLOR } from "../routes/-root-head";

const ACTIVE_THEME_COLOR_ATTRIBUTE = "data-active-theme-color";

/**
 * A computed colour as an `rgb()` the meta element accepts everywhere.
 * `getComputedStyle` keeps a `color-mix()` result in its own colour space
 * (`color(srgb …)`); painting one pixel resolves any syntax to sRGB bytes.
 */
const toRgb = (cssColor: string): string | null => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }
  context.fillStyle = cssColor;
  context.fillRect(0, 0, 1, 1);
  const channels = context.getImageData(0, 0, 1, 1).data.subarray(0, 3);
  return `rgb(${channels.join(" ")})`;
};

/** Publish the painted page background as the active browser chrome colour. */
export const syncThemeColorMeta = (): void => {
  const color = toRgb(getComputedStyle(document.body).backgroundColor);
  if (color === null) {
    return;
  }
  let meta = document.head.querySelector<HTMLMetaElement>(
    `meta[${ACTIVE_THEME_COLOR_ATTRIBUTE}]`,
  );
  if (meta === null) {
    meta = document.createElement("meta");
    meta.name = THEME_COLOR;
    meta.setAttribute(ACTIVE_THEME_COLOR_ATTRIBUTE, "");
    document.head.prepend(meta);
  }
  meta.content = color;
};
