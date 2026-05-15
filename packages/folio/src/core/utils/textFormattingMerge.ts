import type { ColorValue, TextFormatting } from "../types/document";
import { mergeFontFamily } from "./fontFamilyMerge";

export function mergeTextFormatting(
  target: TextFormatting | undefined,
  source: TextFormatting | undefined,
): TextFormatting | undefined {
  if (!source && !target) {
    return undefined;
  }
  if (!source) {
    return target;
  }
  if (!target) {
    return { ...source };
  }

  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source) as (keyof TextFormatting)[]) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }

    if (key === "fontFamily" && typeof value === "object") {
      result["fontFamily"] = mergeFontFamily(
        target.fontFamily,
        value as NonNullable<TextFormatting["fontFamily"]>,
      );
      continue;
    }

    if (key === "color" && typeof value === "object") {
      result["color"] = value as ColorValue;
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = {
        ...(target[key] as Record<string, unknown> | undefined),
        ...(value as Record<string, unknown>),
      };
      continue;
    }

    result[key] = value;
  }

  return result as TextFormatting;
}
