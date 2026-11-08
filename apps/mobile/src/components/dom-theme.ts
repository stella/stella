import { useEffect } from "react";

import { UI_COLORS } from "@/ui-theme.gen";

/**
 * What a DOM component (`"use dom"`) needs to look like the app around it,
 * run inside its web view: stella's colour tokens and the app's appearance,
 * and the address of a font file the web bundle carries.
 */

/** The app's appearance, which a DOM component takes as a prop. */
export type DomAppearance = "light" | "dark";

/**
 * Declares stella's colour tokens, light on `:root` and dark under `.dark`,
 * as the web's theme does: without them every surface falls back to the
 * same white.
 */
let tokensDeclared = false;

const declareThemeTokens = () => {
  if (tokensDeclared) {
    return;
  }
  tokensDeclared = true;
  const variables = (colors: Record<string, string>) =>
    Object.entries(colors)
      .map(
        ([name, value]) =>
          `--${name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}:${value};`,
      )
      .join("");
  const style = document.createElement("style");
  style.textContent = `:root{${variables(UI_COLORS.light)}color-scheme:light;}.dark{${variables(UI_COLORS.dark)}color-scheme:dark;}`;
  document.head.append(style);
};

/**
 * Gives the web view stella's colour tokens and sets its `dark` class from
 * the app's appearance, as the web app sets it on its root.
 */
export const useDomAppearance = (appearance: DomAppearance) => {
  useEffect(() => {
    declareThemeTokens();
    document.documentElement.classList.toggle("dark", appearance === "dark");
  }, [appearance]);
};

/** Where Metro serves a bundled font file from, in a web bundle. */
export const bundledFontUrl = (source: unknown): string | null => {
  if (typeof source === "string") {
    return source;
  }
  if (
    typeof source === "object" &&
    source !== null &&
    "uri" in source &&
    typeof source.uri === "string"
  ) {
    return source.uri;
  }
  return null;
};
