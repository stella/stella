import type { TextProps } from "react-native";
import { Text as NativeText } from "react-native";

import {
  TEXT_VARIANT_CLASS_NAMES,
  TEXT_VARIANT_FACES,
  type TextContract,
  type TextFace,
} from "./text.shared";

/**
 * The embedded font each face is, by the name the app registers it under:
 * DM Sans, the web's typeface, for the interface; the platform's Georgia for
 * reading, since the web reader's Source Serif 4 ships only as web fonts.
 */
const faceName = ({ family, weight, italic }: TextFace): string => {
  if (family === "serif") {
    const bold = weight === "bold" || weight === "semibold";
    if (bold) {
      return italic === true ? "Georgia-BoldItalic" : "Georgia-Bold";
    }
    return italic === true ? "Georgia-Italic" : "Georgia";
  }
  return SANS_FACES[weight];
};

const SANS_FACES = {
  light: "DMSans-Light",
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  semibold: "DMSans-SemiBold",
  bold: "DMSans-Bold",
} as const satisfies Record<TextFace["weight"], string>;

/** `text-` utilities that set a size, alignment or wrapping, not a colour. */
const NOT_A_COLOUR =
  /^text-(?:xs|sm|base|lg|\d*xl|\[|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)/u;

/**
 * `classes` with the foreground colour first, unless they name a colour of
 * their own. Both would be one utility, and the stylesheet orders utilities
 * by name, so `text-foreground` would otherwise win over `text-destructive`
 * whatever order they were written in.
 */
const withForeground = (classes: string): string =>
  classes
    .split(/\s+/u)
    .some((name) => name.startsWith("text-") && !NOT_A_COLOUR.test(name))
    ? classes
    : `text-foreground ${classes}`;

/** The font a role is set in, for a native control that draws its own text. */
export const textFontFamily = (variant: TextContract["variant"]): string =>
  faceName(TEXT_VARIANT_FACES[variant ?? "body"]);

/**
 * Text in one of the design system's roles (./text.shared.ts), as the web
 * renderer (./text.tsx) sets it: the same size and colour, in the role's
 * embedded face.
 */
export const Text = ({
  className,
  style,
  variant = "body",
  ...props
}: Omit<TextProps, keyof TextContract> &
  TextContract & { className?: string | undefined }) => (
  <NativeText
    className={withForeground(
      `${TEXT_VARIANT_CLASS_NAMES[variant]} ${className ?? ""}`,
    )}
    style={[{ fontFamily: textFontFamily(variant) }, style]}
    {...props}
  />
);

export type { TextVariant } from "./text.shared";
