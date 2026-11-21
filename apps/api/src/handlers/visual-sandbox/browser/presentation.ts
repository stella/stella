import type { VisualTheme } from "@stll/api-contract/visual-theme";

import { VISUAL_PRESENTATION_CSS } from "./presentation-css";

declare const STELLA_VISUAL_FONT_FACES: string;

export const installVisualPresentation = (document: Document) => {
  const style = document.createElement("style");
  style.textContent = `${typeof STELLA_VISUAL_FONT_FACES === "string" ? STELLA_VISUAL_FONT_FACES : ""}${VISUAL_PRESENTATION_CSS}`;
  document.head.prepend(style);
};

type ThemeStyle = { id: string; textContent: string | null };

// Only the members the theme writer touches, so tests pass a plain object.
type ThemeDocument<Style extends ThemeStyle> = {
  createElement: (tagName: "style") => Style;
  head: { prepend: (style: Style) => void };
  defaultView: { dispatchEvent: (event: Event) => unknown } | null;
};

// Authored markup may reuse any id, so the runtime keeps its own reference.
const themeStyles = new WeakMap<object, ThemeStyle>();

export const applyVisualTheme = <Style extends ThemeStyle>(
  document: ThemeDocument<Style>,
  theme: VisualTheme,
) => {
  let style = themeStyles.get(document);
  if (style === undefined) {
    const created = document.createElement("style");
    created.id = "stella-theme";
    document.head.prepend(created);
    themeStyles.set(document, created);
    style = created;
  }
  // The caller validates host messages with the shared theme schema.
  style.textContent = `:root{color-scheme:${theme.appearance};${Object.entries(
    theme.variables,
  )
    .map(([name, value]) => `${name}:${value}`)
    .join(";")}}`;
  document.defaultView?.dispatchEvent(new Event("stella-theme-change"));
};
