// The browser chrome colour (Android Chrome's toolbar, an installed app's
// title bar) matches the page background, so the app does not sit inside a
// differently coloured frame.
//
// The server cannot know the stored theme or palette, so the document head
// carries the default palette's background per OS colour scheme. Once the
// theme provider has applied the active theme and palette, it measures the
// painted background and publishes it through one meta element it owns, ahead
// of the static ones: the first matching `theme-color` wins, so an explicit
// light/dark choice or a palette overrides the OS scheme.

const THEME_COLOR = "theme-color";
const ACTIVE_THEME_COLOR_ATTRIBUTE = "data-active-theme-color";

/** The default palette's `--background` per scheme (packages/ui theme.css). */
export const THEME_COLOR_META = [
  {
    name: THEME_COLOR,
    media: "(prefers-color-scheme: light)",
    content: "#ffffff",
  },
  {
    name: THEME_COLOR,
    media: "(prefers-color-scheme: dark)",
    content: "#161616",
  },
] as const;

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
