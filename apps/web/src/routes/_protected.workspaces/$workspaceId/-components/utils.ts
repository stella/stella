import type { OptionColor } from "@stella/api/types";

import type { WorkspaceProperty } from "@/lib/types";

// TODO: remove this
export const isPropertyValid = (property: WorkspaceProperty) => {
  if (property.tool.type === "manual-input") {
    return true;
  }

  return property.tool.prompt.trim().length > 0;
};

type ColorVariants = {
  background: string;
  foreground: string;
  color: string;
};

const optionVar = (name: OptionColor | "empty"): ColorVariants => ({
  background: `var(--option-${name}-bg)`,
  foreground: `var(--option-${name}-fg)`,
  color: `var(--option-${name})`,
});

export const optionColorsMap: Record<OptionColor, ColorVariants> = {
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
};

export const emptyColor: ColorVariants = optionVar("empty");

export const optionColors = Object.keys(optionColorsMap) as OptionColor[];

export const downloadFile = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;

  link.click();

  link.remove();
  URL.revokeObjectURL(url);
};
