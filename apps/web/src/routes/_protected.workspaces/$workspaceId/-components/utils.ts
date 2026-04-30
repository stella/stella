import type { OptionColor } from "@stll/api/types";

import type { WorkspaceProperty } from "@/lib/types";

// TODO: remove this
export const isPropertyValid = (property: WorkspaceProperty) => {
  if (property.tool.type === "manual-input") {
    return true;
  }

  return property.tool.prompt.trim().length > 0;
};

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

/** Backward compat: keyed by named colors only. Use resolveOptionColor for hex support. */
export const optionColorsMap = namedColorsMap as Record<string, ColorVariants>;

/** The 16 named preset color keys. */
export const optionColors: readonly OptionColor[] = NAMED_COLORS;

export const downloadFile = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;

  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
