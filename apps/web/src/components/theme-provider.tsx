import { createContext, use, useSyncExternalStore } from "react";
import type { PropsWithChildren } from "react";

import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from "@/consts";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { forceReflow } from "@/lib/utils";

const THEMES = ["light", "dark", "system"] as const;
type Theme = (typeof THEMES)[number];

const PALETTES = ["nord", "neutral", "flexoki"] as const;
type Palette = (typeof PALETTES)[number];

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
const PREFERENCE_CHANGE_EVENT = "stella-theme-preference-change";

const getStoredTheme = (): Theme => {
  if (typeof localStorage === "undefined") {
    return "system";
  }

  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "system";
};

const getStoredPalette = (): Palette => {
  if (typeof localStorage === "undefined") {
    return "neutral";
  }

  const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
  if (stored === "nord" || stored === "flexoki") {
    return stored;
  }
  return "neutral";
};

const getSystemTheme = (): "light" | "dark" => {
  if (typeof matchMedia === "undefined") {
    return "light";
  }

  if (matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }

  return "light";
};

const subscribeToPreferenceChanges = (onStoreChange: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === PALETTE_STORAGE_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PREFERENCE_CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PREFERENCE_CHANGE_EVENT, onStoreChange);
  };
};

const subscribeToSystemTheme = (onStoreChange: () => void) => {
  const mediaQuery = matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
};

const useStoredTheme = (): Theme =>
  useSyncExternalStore(
    subscribeToPreferenceChanges,
    getStoredTheme,
    () => "system",
  );

const useStoredPalette = (): Palette =>
  useSyncExternalStore(
    subscribeToPreferenceChanges,
    getStoredPalette,
    () => "neutral",
  );

const useSystemTheme = (): "light" | "dark" =>
  useSyncExternalStore(subscribeToSystemTheme, getSystemTheme, () => "light");

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  // Force reflow so suppression takes effect before class changes
  forceReflow(document.documentElement);
  return () => requestAnimationFrame(() => style.remove());
};

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const hydrated = useHydrated();
  const theme = useStoredTheme();
  const palette = useStoredPalette();
  const systemTheme = useSystemTheme();
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const setTheme = (next: Theme) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      window.dispatchEvent(new Event(PREFERENCE_CHANGE_EVENT));
    }
  };

  const setPalette = (next: Palette) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PALETTE_STORAGE_KEY, next);
      window.dispatchEvent(new Event(PREFERENCE_CHANGE_EVENT));
    }
  };

  useExternalSyncEffect(() => {
    if (!hydrated) {
      return;
    }
    const root = document.documentElement;
    const restore = suppressTransitions();
    root.classList.toggle("dark", resolvedTheme === "dark");
    // Override the inline color-scheme/background the pre-paint init script
    // (prepaint-init.js) may have set; inline styles win over the CSS
    // `html { color-scheme }` rule, so without this a dark->light override
    // would leave native scrollbars and form controls painted dark.
    root.style.setProperty("color-scheme", resolvedTheme);
    root.style.removeProperty("background-color");
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
