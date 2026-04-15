import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

import { PALETTE_STORAGE_KEY, THEME_STORAGE_KEY } from "@/consts";

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
  setTheme: () => "system",
  palette: "neutral",
  setPalette: () => "neutral",
  resolvedTheme: "light",
};

const ThemeProviderContext = createContext(initialState);

const PALETTE_PREFIX = "palette-";

const getStoredTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "system";
};

const getStoredPalette = (): Palette => {
  const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
  if (stored === "nord" || stored === "flexoki") {
    return stored;
  }
  return "neutral";
};

const getSystemTheme = (): "light" | "dark" =>
  matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const resolveTheme = (theme: Theme): "light" | "dark" =>
  theme === "system" ? getSystemTheme() : theme;

const suppressTransitions = () => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
  // Force reflow so suppression takes effect before class changes
  // oxlint-disable-next-line no-unused-expressions
  getComputedStyle(document.documentElement).opacity;
  return () => requestAnimationFrame(() => style.remove());
};

export const ThemeProvider = ({ children }: PropsWithChildren) => {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);
  const [palette, setPaletteState] = useState<Palette>(getStoredPalette);
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(theme),
  );

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  const setPalette = useCallback((next: Palette) => {
    localStorage.setItem(PALETTE_STORAGE_KEY, next);
    setPaletteState(next);
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    const updateTheme = () => {
      const resolved = resolveTheme(theme);
      const restore = suppressTransitions();
      root.classList.toggle("dark", resolved === "dark");
      setResolvedTheme(resolved);
      restore();
    };

    updateTheme();

    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") {
        updateTheme();
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
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
  }, [palette]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) {
        if (e.newValue === "light" || e.newValue === "dark") {
          setThemeState(e.newValue);
        } else {
          setThemeState("system");
        }
      }
      if (e.key === PALETTE_STORAGE_KEY) {
        if (e.newValue === "nord" || e.newValue === "flexoki") {
          setPaletteState(e.newValue);
        } else {
          setPaletteState("neutral");
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      palette,
      setPalette,
      resolvedTheme,
    }),
    [theme, setTheme, palette, setPalette, resolvedTheme],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
};

export const useTheme = (): ThemeProviderState => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined || context === null) {
    panic("useTheme must be used within a ThemeProvider");
  }
  return context;
};

export { THEMES, PALETTES };
