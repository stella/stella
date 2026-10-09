import { panic } from "better-result";
import * as v from "valibot";

export const VISUAL_THEME_SCRIPT_ID = "stella-visual-theme-data";

export const VISUAL_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--card",
  "--border",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--destructive",
  "--ring",
  "--radius",
  "--font-sans",
  "--font-mono",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
] as const;

type VisualThemeVariable = (typeof VISUAL_THEME_VARIABLES)[number];
type VisualThemeValueKind = "color" | "length" | "font-family";

const VISUAL_THEME_VALUE_KINDS = {
  "--background": "color",
  "--foreground": "color",
  "--muted": "color",
  "--muted-foreground": "color",
  "--card": "color",
  "--border": "color",
  "--primary": "color",
  "--primary-foreground": "color",
  "--accent": "color",
  "--destructive": "color",
  "--ring": "color",
  "--radius": "length",
  "--font-sans": "font-family",
  "--font-mono": "font-family",
  "--chart-1": "color",
  "--chart-2": "color",
  "--chart-3": "color",
  "--chart-4": "color",
  "--chart-5": "color",
  "--chart-6": "color",
  "--chart-7": "color",
  "--chart-8": "color",
} as const satisfies Record<VisualThemeVariable, VisualThemeValueKind>;

const COLOR_FUNCTIONS = new Set([
  "--alpha",
  "color-mix",
  "hsl",
  "hsla",
  "light-dark",
  "oklab",
  "oklch",
  "rgb",
  "rgba",
  "var",
]);
// No `*`: a comment opener would hide the declarations after it.
const COLOR_CHARACTERS = /^[a-z0-9#%.,+/()\s-]+$/iu;
const COLOR_LITERAL = /^(?:#[\da-f]{3,8}|[a-z]+)$/iu;
const CSS_FUNCTION = /([a-z-]+)\s*\(/giu;
const LENGTH_VALUE =
  /^(?:(?:0|(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|ex|cap|ic|lh|rlh|vw|vh|vmin|vmax|%))(?:\s+|$)){1,4}$/iu;
const FONT_FAMILY =
  /^(?:"[a-z0-9 -]+"|'[a-z0-9 -]+'|[a-z][a-z0-9 -]*)(?:\s*,\s*(?:"[a-z0-9 -]+"|'[a-z0-9 -]+'|[a-z][a-z0-9 -]*))*$/iu;

const isColorValue = (value: string) => {
  if (COLOR_LITERAL.test(value)) {
    return true;
  }
  if (!COLOR_CHARACTERS.test(value) || !value.includes("(")) {
    return false;
  }
  const functions = [...value.matchAll(CSS_FUNCTION)];
  return (
    functions.length > 0 &&
    functions.every((match) => COLOR_FUNCTIONS.has(match.at(1) ?? ""))
  );
};

const isVisualThemeValue = (name: VisualThemeVariable, value: string) => {
  switch (VISUAL_THEME_VALUE_KINDS[name]) {
    case "color":
      return isColorValue(value);
    case "length":
      return LENGTH_VALUE.test(value);
    case "font-family":
      return FONT_FAMILY.test(value);
    default:
      VISUAL_THEME_VALUE_KINDS[name] satisfies never;
      return panic("Unhandled visual theme value kind");
  }
};

const visualThemeValueSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
);

// Both shell and guest validate this host-only stylesheet input. Finite key and
// kind-specific value vocabularies prevent declarations from escaping :root.
export const visualThemeSchema = v.strictObject({
  appearance: v.picklist(["light", "dark"]),
  variables: v.pipe(
    v.record(v.picklist(VISUAL_THEME_VARIABLES), visualThemeValueSchema),
    v.check((variables) =>
      VISUAL_THEME_VARIABLES.every((name) => {
        const value = variables[name];
        return value === undefined || isVisualThemeValue(name, value);
      }),
    ),
  ),
});

export type VisualTheme = v.InferOutput<typeof visualThemeSchema>;

export const visualThemeMessageSchema = v.strictObject({
  kind: v.literal("theme"),
  theme: visualThemeSchema,
});
