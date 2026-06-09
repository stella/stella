import { clearAllCaches } from "../cache";
import { resetCanvasContext } from "../measureContainer";

/** Width contribution of a single character, given the active canvas font. */
export type FakeCharWidth = (char: string, font: string) => number;

/** Uppercase letters render wider than everything else. */
export const uppercaseAwareCharWidth: FakeCharWidth = (char) =>
  char >= "A" && char <= "Z" ? 10 : 5;

/** Uppercase = 10, small-caps lowercase = 8, everything else = 5. */
export const smallCapsAwareCharWidth: FakeCharWidth = (char, font) => {
  if (char >= "A" && char <= "Z") {
    return 10;
  }
  if (font.includes("small-caps") && char >= "a" && char <= "z") {
    return 8;
  }
  return 5;
};

/** Every character is `px` wide, regardless of glyph. */
export const fixedCharWidth =
  (px: number): FakeCharWidth =>
  () =>
    px;

type FakeTextMeasureOptions = {
  /** Per-character width; defaults to {@link uppercaseAwareCharWidth}. */
  charWidth?: FakeCharWidth;
};

/**
 * Run `runTest` with a deterministic canvas text-measure stub installed on
 * `globalThis.document`, then restore the real document. The stub makes layout
 * measurement reproducible across machines without a real browser canvas, so
 * layout/pagination assertions stay stable. `getMeasureCount` reports how many
 * times `measureText` was invoked (for caching assertions); ignore it when not
 * needed.
 */
export function withFakeTextMeasure(
  runTest: (getMeasureCount: () => number) => void,
  options: FakeTextMeasureOptions = {},
): void {
  const charWidth = options.charWidth ?? uppercaseAwareCharWidth;
  const originalDocument = globalThis.document;
  let measureCount = 0;
  const fakeDocument = {
    createElement() {
      return {
        getContext() {
          return {
            font: "",
            measureText(this: { font: string }, text: string) {
              measureCount += 1;
              let width = 0;
              for (const char of text) {
                width += charWidth(char, this.font);
              }
              return {
                width,
                actualBoundingBoxAscent: 8,
                actualBoundingBoxDescent: 2,
              };
            },
          };
        },
      };
    },
  } as unknown as Document;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });
  clearAllCaches();
  resetCanvasContext();
  try {
    runTest(() => measureCount);
  } finally {
    resetCanvasContext();
    clearAllCaches();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }
}
