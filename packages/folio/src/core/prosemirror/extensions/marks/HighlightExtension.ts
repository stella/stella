/**
 * Highlight/Background Color Mark Extension
 */

import { panic } from "better-result";

import type { TextFormatting } from "../../../types/document";
import { HIGHLIGHT_COLOR_VALUES } from "../../../types/documentEnumValues";
import { resolveHighlightToCss } from "../../../utils/colorResolver";
import { expectHighlightMarkAttrs } from "../../attrs";
import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { setMark, removeMark } from "./markUtils";

type HighlightColor = NonNullable<TextFormatting["highlight"]>;

const CSS_HIGHLIGHT_TO_NAME: Record<string, HighlightColor> = {
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  "#000000": "black",
  "#00008b": "darkBlue",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  "#0000ff": "blue",
  "#006400": "darkGreen",
  "#008000": "darkGreen",
  "#008080": "darkCyan",
  "#008b8b": "darkCyan",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  "#00ff00": "green",
  "#00ffff": "cyan",
  "#800080": "darkMagenta",
  "#808000": "darkYellow",
  "#808080": "darkGray",
  "#8b0000": "darkRed",
  "#a9a9a9": "darkGray",
  "#c0c0c0": "lightGray",
  "#d3d3d3": "lightGray",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  "#ff0000": "red",
  "#ff00ff": "magenta",
  "#ffff00": "yellow",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  "#ffffff": "white",
  aqua: "cyan",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  black: "black",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  blue: "blue",
  cyan: "cyan",
  darkblue: "darkBlue",
  darkcyan: "darkCyan",
  darkgray: "darkGray",
  darkgreen: "darkGreen",
  darkgrey: "darkGray",
  darkmagenta: "darkMagenta",
  darkred: "darkRed",
  fuchsia: "magenta",
  gray: "darkGray",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  green: "green",
  grey: "darkGray",
  lightgray: "lightGray",
  lightgrey: "lightGray",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  lime: "green",
  magenta: "magenta",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  red: "red",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS color parser table, not UI styling.
  white: "white",
  yellow: "yellow",
};

const readHighlightName = (value: string): HighlightColor | null => {
  for (const color of HIGHLIGHT_COLOR_VALUES) {
    if (color === value) {
      return color;
    }
  }
  return null;
};

const normalizeCssColorKey = (value: string): string => {
  const compact = value.trim().toLowerCase().replace(/\s+/gu, "");
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/u.exec(compact);
  const hex = hexMatch?.[1];
  if (hex) {
    return hex.length === 3
      ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
      : `#${hex}`;
  }

  const rgbMatch = /^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,[^)]+)?\)$/u.exec(
    compact,
  );
  if (!rgbMatch) {
    return compact;
  }

  const [, red, green, blue] = rgbMatch;
  return `#${cssColorComponentToHex(red)}${cssColorComponentToHex(green)}${cssColorComponentToHex(blue)}`;
};

const cssColorComponentToHex = (value: string | undefined): string => {
  const component = Number(value);
  if (!Number.isFinite(component)) {
    return "00";
  }
  return Math.min(255, Math.max(0, component)).toString(16).padStart(2, "0");
};

const parseDOMHighlightColor = (value: string): HighlightColor | null => {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed === "inherit" ||
    trimmed === "initial" ||
    trimmed === "none" ||
    trimmed === "transparent" ||
    trimmed === "unset"
  ) {
    return null;
  }

  const namedColor = readHighlightName(trimmed);
  if (namedColor && namedColor !== "none") {
    return namedColor;
  }

  return CSS_HIGHLIGHT_TO_NAME[normalizeCssColorKey(trimmed)] ?? null;
};

export const HighlightExtension = createMarkExtension({
  name: "highlight",
  schemaMarkName: "highlight",
  markSpec: {
    attrs: {
      color: { default: "yellow" },
    },
    parseDOM: [
      {
        tag: "mark",
      },
      {
        style: "background-color",
        getAttrs: (value) => {
          const color = parseDOMHighlightColor(value);
          if (color) {
            return { color };
          }
          return false;
        },
      },
    ],
    toDOM(mark) {
      const { color } = expectHighlightMarkAttrs(mark);
      // Resolve OOXML named highlight color (e.g., 'yellow' → '#FFFF00')
      const cssColor = resolveHighlightToCss(color);
      return ["mark", { style: `background-color: ${cssColor}` }, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const highlightType = ctx.schema.marks["highlight"];
    if (!highlightType) {
      panic("Missing mark type: highlight");
    }
    return {
      commands: {
        setHighlight: (color: string) => {
          if (!color || color === "none") {
            return removeMark(highlightType);
          }
          return setMark(highlightType, {
            color: parseDOMHighlightColor(color) ?? "yellow",
          });
        },
        clearHighlight: () => removeMark(highlightType),
      },
    };
  },
});
