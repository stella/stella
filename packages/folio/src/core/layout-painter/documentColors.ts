const HEX_COLOR_RE = /^#?[0-9a-f]{6}$/i;

function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim();
  if (!HEX_COLOR_RE.test(trimmed)) {
    return null;
  }
  return `#${trimmed.replace(/^#/, "").toUpperCase()}`;
}

function relativeLuminance(hexColor: string): number | null {
  const normalized = normalizeHexColor(hexColor);
  if (!normalized) {
    return null;
  }

  const hex = normalized.slice(1);
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    return null;
  }

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getAutomaticTextColorForBackground(
  backgroundColor: string | undefined,
): string | undefined {
  if (!backgroundColor) {
    return undefined;
  }

  const luminance = relativeLuminance(backgroundColor);
  if (luminance === null) {
    return undefined;
  }

  return luminance > 0.45 ? "#000000" : "#FFFFFF";
}
