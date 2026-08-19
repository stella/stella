/**
 * The kit's colour token for user-chosen option colours.
 *
 * A token is either one of the sixteen named presets, which resolve to the
 * theme's `--option-*` custom properties, or a six-character hex string, which
 * resolves to a `color-mix` against the current background and foreground. The
 * indirection is what keeps a stored colour theme-aware: nothing persists a
 * literal colour the palette cannot re-tint.
 *
 * This lives in the kit rather than beside a data model because the resolver is
 * pure presentation: it maps a token to CSS, and knows nothing about what the
 * token was chosen for.
 */

/** Named preset or arbitrary 6-character hex colour (e.g. "FF0000"). */
export type OptionColor =
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "gray"
  | (string & Record<never, never>);

export type ColorVariants = {
  background: string;
  foreground: string;
  color: string;
};

/** Named preset colors with CSS variable references. */
const NAMED_COLORS = Object.freeze([
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "gray",
] as const);

type NamedColor = (typeof NAMED_COLORS)[number];

const optionVar = (name: NamedColor | "empty"): ColorVariants => ({
  background: `var(--option-${name}-bg)`,
  foreground: `var(--option-${name}-fg)`,
  color: `var(--option-${name})`,
});

const hexVar = (hex: string): ColorVariants => ({
  background: `color-mix(in srgb, #${hex} 12%, var(--background))`,
  foreground: `color-mix(in srgb, #${hex} 50%, var(--foreground))`,
  color: `#${hex}`,
});

const namedColorsMap = {
  red: optionVar("red"),
  orange: optionVar("orange"),
  amber: optionVar("amber"),
  yellow: optionVar("yellow"),
  lime: optionVar("lime"),
  green: optionVar("green"),
  emerald: optionVar("emerald"),
  teal: optionVar("teal"),
  cyan: optionVar("cyan"),
  sky: optionVar("sky"),
  blue: optionVar("blue"),
  indigo: optionVar("indigo"),
  violet: optionVar("violet"),
  purple: optionVar("purple"),
  fuchsia: optionVar("fuchsia"),
  gray: optionVar("gray"),
} as const satisfies Record<NamedColor, ColorVariants>;

export const emptyColor: ColorVariants = optionVar("empty");

/** Resolve any OptionColor (named or hex) to CSS color variants. */
export const resolveOptionColor = (color: OptionColor): ColorVariants => {
  const namedColor = NAMED_COLORS.find((candidate) => candidate === color);
  if (namedColor !== undefined) {
    return namedColorsMap[namedColor];
  }
  return hexVar(color);
};

/** The 16 named preset color keys. */
export const optionColors: readonly OptionColor[] = NAMED_COLORS;
