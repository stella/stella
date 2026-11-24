/**
 * Whether the desktop draws light, dark or as the system does. The native
 * side owns the choice (`src-tauri/src/appearance.rs`); every window asks it
 * on start and follows its change event after.
 *
 * Windows share one origin, so they also share the copy kept under
 * `DESKTOP_APPEARANCE_STORAGE_KEY`. It is only a paint-time hint:
 * `public/prepaint-theme.js` reads it synchronously, before the window can
 * ask the native side, so the first frame is drawn in the chosen scheme.
 * Whatever the native side answers replaces it.
 */

import { panic, Result } from "better-result";

/** The native `Appearance` variants, in their declaration order. */
export const DESKTOP_APPEARANCES = ["system", "light", "dark"] as const;

export type DesktopAppearance = (typeof DESKTOP_APPEARANCES)[number];

export type DesktopColorScheme = "light" | "dark";

export const DESKTOP_APPEARANCE_CHANGED_EVENT = "desktop-appearance-changed";

/** The pre-paint script spells this key out; a browser test holds the two together. */
export const DESKTOP_APPEARANCE_STORAGE_KEY = "stella-desktop-appearance";

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export const isDesktopAppearance = (
  value: unknown,
): value is DesktopAppearance =>
  DESKTOP_APPEARANCES.some((appearance) => appearance === value);

export const effectiveColorScheme = (
  appearance: DesktopAppearance,
  systemPrefersDark: boolean,
): DesktopColorScheme => {
  switch (appearance) {
    case "system":
      return systemPrefersDark ? "dark" : "light";
    case "light":
    case "dark":
      return appearance;
    default:
      appearance satisfies never;
      return panic("Unknown desktop appearance");
  }
};

/** The copy the last window saw; "system" when there is none to read. */
export const readCachedAppearance = (): DesktopAppearance => {
  const stored = Result.try(() =>
    localStorage.getItem(DESKTOP_APPEARANCE_STORAGE_KEY),
  );
  return Result.isOk(stored) && isDesktopAppearance(stored.value)
    ? stored.value
    : "system";
};

/** Without storage the next window paints its first frame in the system
 *  scheme and switches once the native side answers. */
export const cacheAppearance = (appearance: DesktopAppearance): boolean =>
  Result.isOk(
    Result.try(() => {
      localStorage.setItem(DESKTOP_APPEARANCE_STORAGE_KEY, appearance);
    }),
  );
