/**
 * Font Loader
 *
 * Manages font availability for the DOCX editor. Fonts are bundled via
 * fontsource packages (WOFF2, no external requests). This module
 * tracks which fonts are loaded and provides callbacks for re-rendering
 * when fonts become available.
 */

// Track loaded fonts to avoid duplicate work
const loadedFonts = new Set<string>();

// Track fonts currently being loaded
const loadingFonts = new Map<string, Promise<boolean>>();

// Callbacks to notify when fonts are loaded
const loadCallbacks = new Set<(fonts: string[]) => void>();

// Track overall loading state
let isLoadingAny = false;

/**
 * Mapping from common Office/system fonts to bundled Croscore equivalents.
 * The CSS @font-face aliases in font-aliases.css handle the visual mapping;
 * this map is used for font availability checks and preloading.
 */
export const FONT_MAPPING: Record<string, string> = {
  Calibri: "Carlito",
  Cambria: "Caladea",
  Arial: "Arimo",
  "Times New Roman": "Tinos",
  "Courier New": "Cousine",
  // Additional common document fonts → system fallbacks
  Garamond: "serif",
  Georgia: "serif",
  Verdana: "sans-serif",
  Tahoma: "sans-serif",
  "Trebuchet MS": "sans-serif",
  "Segoe UI": "sans-serif",
  Consolas: "monospace",
  "Lucida Console": "monospace",
};

/** Bundled font families (available without network requests). */
const BUNDLED_FONTS = new Set([
  "Carlito",
  "Caladea",
  "Arimo",
  "Tinos",
  "Cousine",
  // Also register the Microsoft names since @font-face aliases exist
  "Calibri",
  "Cambria",
  "Arial",
  "Times New Roman",
  "Courier New",
]);

/**
 * Mark a font as loaded. For bundled fonts this is immediate;
 * for others it checks CSS Font Loading API.
 */
export function loadFont(fontFamily: string): Promise<boolean> {
  if (typeof document === "undefined") {
    return Promise.resolve(false);
  }

  const normalized = fontFamily.trim();

  if (loadedFonts.has(normalized)) {
    return Promise.resolve(true);
  }

  const existing = loadingFonts.get(normalized);
  if (existing) {
    return existing;
  }

  // Check if this is a bundled font or has a bundled equivalent
  const mapped = FONT_MAPPING[normalized] ?? normalized;
  if (BUNDLED_FONTS.has(normalized) || BUNDLED_FONTS.has(mapped)) {
    loadedFonts.add(normalized);
    notifyCallbacks([normalized]);
    return Promise.resolve(true);
  }

  // For non-bundled fonts, check if the system has it
  const loadPromise = (async (): Promise<boolean> => {
    isLoadingAny = true;
    try {
      if ("fonts" in document) {
        const check = `400 16px "${normalized}"`;
        await Promise.race([
          document.fonts.load(check),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          }),
        ]);
        const available = document.fonts.check(check);
        if (available) {
          loadedFonts.add(normalized);
          notifyCallbacks([normalized]);
        }
        return available;
      }
      return false;
    } finally {
      loadingFonts.delete(normalized);
      if (loadingFonts.size === 0) {
        isLoadingAny = false;
      }
    }
  })();

  loadingFonts.set(normalized, loadPromise);
  return loadPromise;
}

/**
 * Load multiple fonts.
 */
export async function loadFonts(families: string[]): Promise<void> {
  const toLoad = families.filter((f) => !loadedFonts.has(f.trim()));
  if (toLoad.length === 0) {
    return;
  }
  await Promise.all(toLoad.map((f) => loadFont(f)));
}

/**
 * Load fonts with mapping: maps Office font names to bundled equivalents
 * and marks them as loaded.
 */
export async function loadFontsWithMapping(
  families: string[] | undefined,
): Promise<void> {
  if (!families || families.length === 0) {
    return;
  }
  await loadFonts(families);
}

export function isFontLoaded(fontFamily: string): boolean {
  return loadedFonts.has(fontFamily.trim());
}

export function isLoading(): boolean {
  return isLoadingAny;
}

export function getLoadedFonts(): string[] {
  return Array.from(loadedFonts);
}

export function onFontsLoaded(callback: (fonts: string[]) => void): () => void {
  loadCallbacks.add(callback);
  return () => loadCallbacks.delete(callback);
}

function notifyCallbacks(fonts: string[]): void {
  for (const callback of loadCallbacks) {
    try {
      callback(fonts);
    } catch {
      // ignore
    }
  }
}

/**
 * Check if a font is available using canvas measurement.
 */
export function canRenderFont(
  fontFamily: string,
  fallbackFont = "sans-serif",
): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return false;
  }

  const text = "abcdefghijklmnopqrstuvwxyz0123456789";
  ctx.font = `72px ${fallbackFont}`;
  const fallbackWidth = ctx.measureText(text).width;
  ctx.font = `72px "${fontFamily}", ${fallbackFont}`;
  const customWidth = ctx.measureText(text).width;
  return customWidth !== fallbackWidth;
}

/**
 * Load a font from a raw buffer (e.g., embedded in DOCX).
 */
export async function loadFontFromBuffer(
  fontFamily: string,
  buffer: ArrayBuffer,
  options?: { weight?: number | string; style?: "normal" | "italic" },
): Promise<boolean> {
  const normalized = fontFamily.trim();
  if (loadedFonts.has(normalized)) {
    return true;
  }

  try {
    const blob = new Blob([buffer], { type: "font/ttf" });
    const url = URL.createObjectURL(blob);

    const style = document.createElement("style");
    style.textContent = `
      @font-face {
        font-family: "${normalized}";
        src: url(${url}) format('truetype');
        font-weight: ${options?.weight ?? "normal"};
        font-style: ${options?.style ?? "normal"};
        font-display: swap;
      }
    `;
    document.head.append(style);

    if ("fonts" in document) {
      const check = `${options?.weight ?? 400} 16px "${normalized}"`;
      await Promise.race([
        document.fonts.load(check),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 3000);
        }),
      ]);
    }

    loadedFonts.add(normalized);
    notifyCallbacks([normalized]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preload common document fonts (no-op now since fonts are bundled).
 */
export function preloadCommonFonts(): void {
  for (const font of BUNDLED_FONTS) {
    loadedFonts.add(font);
  }
}
