import type { TextFormatting } from "../types/document";

type FontFamily = NonNullable<TextFormatting["fontFamily"]>;

export function mergeFontFamily(
  target: FontFamily | undefined,
  source: FontFamily,
): FontFamily {
  const result: Record<string, unknown> = {};
  const src = source as Record<string, unknown>;
  const replacesAscii =
    source.ascii !== undefined || source.asciiTheme !== undefined;
  const replacesHAnsi =
    source.hAnsi !== undefined || source.hAnsiTheme !== undefined;
  const replacesEastAsia =
    source.eastAsia !== undefined || source.eastAsiaTheme !== undefined;
  const replacesCs = source.cs !== undefined || source.csTheme !== undefined;

  if (target) {
    for (const key of Object.keys(target) as (keyof FontFamily)[]) {
      if (
        (replacesAscii && (key === "ascii" || key === "asciiTheme")) ||
        (replacesHAnsi && (key === "hAnsi" || key === "hAnsiTheme")) ||
        (replacesEastAsia && (key === "eastAsia" || key === "eastAsiaTheme")) ||
        (replacesCs && (key === "cs" || key === "csTheme"))
      ) {
        continue;
      }
      result[key] = target[key];
    }
  }

  const pairs: [string, string][] = [
    ["ascii", "asciiTheme"],
    ["hAnsi", "hAnsiTheme"],
    ["eastAsia", "eastAsiaTheme"],
    ["cs", "csTheme"],
  ];
  const pairKeys = new Set<string>();

  for (const [explicit, theme] of pairs) {
    pairKeys.add(explicit);
    pairKeys.add(theme);
    if (src[explicit] === undefined && src[theme] === undefined) {
      continue;
    }
    if (src[explicit] !== undefined) {
      result[explicit] = src[explicit];
    }
    if (src[theme] !== undefined) {
      result[theme] = src[theme];
    }
  }

  for (const key of Object.keys(src)) {
    if (!pairKeys.has(key) && src[key] !== undefined) {
      result[key] = src[key];
    }
  }

  return result as FontFamily;
}
