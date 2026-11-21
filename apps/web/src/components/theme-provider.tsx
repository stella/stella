import {
  createContext,
  use,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import type { PropsWithChildren } from "react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { PALETTES, THEMES } from "@/lib/account/presentation-prefs/preferences";
import type { PresentationPrefs } from "@/lib/account/presentation-prefs/preferences";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { forceReflow } from "@/lib/utils";

import { syncThemeColorMeta } from "./theme-color";

type Theme = PresentationPrefs["theme"];

type Palette = PresentationPrefs["palette"];

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  palette: Palette;
  setPalette: (palette: Palette) => void;
  resolvedTheme: "light" | "dark";
};

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => undefined,
  palette: "neutral",
  setPalette: () => undefined,
  resolvedTheme: "light",
};

const ThemeProviderContext = createContext(initialState);

const PALETTE_PREFIX = "palette-";
const getSystemTheme = (): "light" | "dark" => {
  if (typeof matchMedia === "undefined") {
    return "light";
  }

  if (matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }

  return "light";
};

const subscribeToSystemTheme = (onStoreChange: () => void) => {
  const mediaQuery = matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
};

const useSystemTheme = (): "light" | "dark" =>
  useSyncExternalStore(subscribeToSystemTheme, getSystemTheme, () => "light");

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  // Force reflow so suppression takes effect before class changes
  forceReflow(document.documentElement);
  return () => {
    // Commit the themed values while transitions are still suppressed. A
    // requestAnimationFrame callback runs before paint, so removing the style
    // without this second flush can animate the theme change after all.
    forceReflow(document.documentElement);
    requestAnimationFrame(() => style.remove());
  };
};

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const hydrated = useHydrated();
  const {
    prefs: { theme, palette },
    setPrefs,
  } = usePresentationPrefs();
  const systemTheme = useSystemTheme();
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const setTheme = (next: Theme) => {
    setPrefs(() => ({ theme: next }));
  };

  const setPalette = (next: Palette) => {
    setPrefs(() => ({ palette: next }));
  };

  useLayoutEffect(() => {
    if (!hydrated) {
      return;
    }
    const root = document.documentElement;
    const restore = suppressTransitions();
    root.classList.toggle("dark", resolvedTheme === "dark");
    // Keep native controls in sync when an explicit theme replaces system mode.
    root.style.setProperty("color-scheme", resolvedTheme);
    syncThemeColorMeta();
    restore();
  }, [hydrated, resolvedTheme]);

  useExternalSyncEffect(() => {
    if (!hydrated) {
      return;
    }
    const root = document.documentElement;
    const restore = suppressTransitions();

    for (const className of [...root.classList]) {
      if (className.startsWith(PALETTE_PREFIX)) {
        root.classList.remove(className);
      }
    }

    if (palette !== "neutral") {
      root.classList.add(`${PALETTE_PREFIX}${palette}`);
    }

    syncThemeColorMeta();
    restore();
  }, [hydrated, palette]);

  return (
    <ThemeProviderContext
      value={{ theme, setTheme, palette, setPalette, resolvedTheme }}
    >
      {children}
    </ThemeProviderContext>
  );
};

export const useTheme = (): ThemeProviderState => use(ThemeProviderContext);

export { THEMES, PALETTES };
