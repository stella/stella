import type { OptionColor } from "@stll/workspace-ui/types";

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
  const named = (namedColorsMap as Record<string, ColorVariants | undefined>)[
    color
  ];
  if (named !== undefined) {
    return named;
  }
  return hexVar(color);
};
