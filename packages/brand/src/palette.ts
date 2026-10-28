import { panic } from "better-result";

/** A CSS hex colour: `#rgb` or `#rrggbb`. */
export type HexColor = `#${string}`;

/** An sRGB colour with each channel in 0..1, the form PDF operators take. */
export type SrgbColor = readonly [red: number, green: number, blue: number];

type BrandColor = {
  readonly label: string;
  readonly hex: HexColor;
  readonly usage: string;
};

/**
 * The brand palette. DESIGN.md's "Brand Colours" table is rendered from this
 * list by scripts/design-tokens-doc.ts, so the two cannot drift. Interface
 * colour comes from the theme tokens; these are for the marks and surfaces
 * that carry the brand itself.
 */
export const BRAND_PALETTE = {
  black: { label: "Black", hex: "#000", usage: "Primary text, logo mark" },
  softBlue: {
    label: "Soft Blue",
    hex: "#cae1fb",
    usage: "Illustration/accent background",
  },
  paleBlue: {
    label: "Pale Blue",
    hex: "#e2f6fd",
    usage: "Light tint surfaces",
  },
  blueAccent: {
    label: "Blue Accent",
    hex: "#59a1d4",
    usage: "Accent in marketing material",
  },
} as const satisfies Record<string, BrandColor>;

export type BrandColorName = keyof typeof BRAND_PALETTE;

/** The brand palette's hex values by name. */
export const BRAND_COLORS: {
  readonly [Name in BrandColorName]: (typeof BRAND_PALETTE)[Name]["hex"];
} = {
  black: BRAND_PALETTE.black.hex,
  softBlue: BRAND_PALETTE.softBlue.hex,
  paleBlue: BRAND_PALETTE.paleBlue.hex,
  blueAccent: BRAND_PALETTE.blueAccent.hex,
};

/**
 * The neutral ends that output with no theme draws with: the paper and ink of
 * a generated PDF, a canvas page or a QR code. Not brand colours, and never
 * interface chrome, which takes the theme's tokens.
 */
export const NEUTRAL_COLORS = {
  black: BRAND_COLORS.black,
  white: "#fff",
} as const satisfies Record<string, HexColor>;

/**
 * Colours the brand's own marks draw with beyond the palette: the app icon's
 * ground and the unread badge the browser tab icon carries. A mark is an
 * image, so it cannot take a theme token.
 */
export const MARK_COLORS = {
  iconGround: BRAND_COLORS.blueAccent,
  unreadBadge: "#ef4444",
} as const satisfies Record<string, HexColor>;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const HEX_DIGITS = "0123456789abcdef";

// A validated two-digit hex pair as 0..255: each digit's value is its place
// in HEX_DIGITS.
const hexPairValue = (pair: string): number => {
  const lower = pair.toLowerCase();
  return (
    HEX_DIGITS.indexOf(lower.charAt(0)) * 16 +
    HEX_DIGITS.indexOf(lower.charAt(1))
  );
};

/** The 0..255 channels of a `#rgb` or `#rrggbb` colour. */
const hexChannels = (hex: HexColor): readonly [number, number, number] => {
  if (!HEX.test(hex)) {
    return panic(`Not a #rgb or #rrggbb colour: ${hex}`);
  }
  const digits =
    hex.length === 4
      ? [hex.slice(1, 2), hex.slice(2, 3), hex.slice(3, 4)].map(
          (digit) => digit + digit,
        )
      : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  const [red = 0, green = 0, blue = 0] = digits.map(hexPairValue);
  return [red, green, blue];
};

/** A hex colour as sRGB channels in 0..1. */
export const srgbFromHex = (hex: HexColor): SrgbColor => {
  const [red, green, blue] = hexChannels(hex);
  return [red / 255, green / 255, blue / 255];
};

/** The brand palette as sRGB channels in 0..1, derived from the hex values. */
export const BRAND_SRGB: Readonly<Record<BrandColorName, SrgbColor>> = {
  black: srgbFromHex(BRAND_COLORS.black),
  softBlue: srgbFromHex(BRAND_COLORS.softBlue),
  paleBlue: srgbFromHex(BRAND_COLORS.paleBlue),
  blueAccent: srgbFromHex(BRAND_COLORS.blueAccent),
};

/** The neutral ends as sRGB channels in 0..1, derived from the hex values. */
export const NEUTRAL_SRGB: {
  readonly [Name in keyof typeof NEUTRAL_COLORS]: SrgbColor;
} = {
  black: srgbFromHex(NEUTRAL_COLORS.black),
  white: srgbFromHex(NEUTRAL_COLORS.white),
};
