// The button's contract, shared by its two renderers: the web's
// (./button.tsx, a <button> through Base UI) and React Native's
// (./button.native.tsx, a Pressable). Both read the variant tokens below and
// accept exactly the sizes listed, so a variant cannot exist on one platform
// and not the other, and a colour changes on both at once.
//
// Tokens name semantic colours (`bg-primary`, `text-destructive-foreground`)
// that Tailwind on the web and uniwind on React Native both compile from the
// same theme. What only one platform can express (hover, focus rings, inset
// shadows on the web; touch feedback on a phone) stays in its renderer.

import type { ReactNode } from "react";

/**
 * Each variant's colours: the box (`surface`: border and fill) and the
 * label. Neither carries state; each renderer adds its own hover, press and
 * focus treatment on top.
 */
export const BUTTON_VARIANT_TOKENS = {
  default: {
    surface: "border-primary bg-primary",
    label: "text-primary-foreground",
  },
  destructive: {
    surface: "border-destructive/32 bg-destructive/10",
    label: "text-destructive-foreground",
  },
  "destructive-outline": {
    surface: "border-input bg-popover",
    label: "text-destructive-foreground",
  },
  "destructive-ghost": {
    surface: "border-transparent",
    label: "text-destructive",
  },
  ghost: { surface: "border-transparent", label: "text-foreground" },
  // A link inherits its colour on the web; a phone has no colour to inherit,
  // so the native renderer sets the foreground itself.
  link: { surface: "border-transparent", label: "" },
  // Quiet action: muted until hovered or pressed.
  muted: { surface: "border-transparent", label: "text-muted-foreground" },
  outline: { surface: "border-input bg-popover", label: "text-foreground" },
  secondary: {
    surface: "border-transparent bg-secondary",
    label: "text-secondary-foreground",
  },
} as const satisfies Record<string, { surface: string; label: string }>;

export type ButtonVariant = keyof typeof BUTTON_VARIANT_TOKENS;

/** Every size a button comes in, on every platform. */
export const BUTTON_SIZES = [
  "chip",
  "default",
  "icon",
  "icon-lg",
  "icon-sm",
  "icon-xl",
  "icon-xs",
  "lg",
  "row",
  "sm",
  "xl",
  "xs",
] as const;

export type ButtonSize = (typeof BUTTON_SIZES)[number];

/**
 * The props every button renderer accepts, with one meaning. A renderer adds
 * its platform's own props (a web button's `type` and `render`, a Pressable's
 * `onPress` and `hitSlop`) on top.
 */
export type ButtonContract = {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
  /** Busy: a spinner takes the icon's place and the button cannot act. */
  loading?: boolean;
  disabled?: boolean;
  /** A glyph before the label. */
  icon?: ReactNode;
  children?: ReactNode;
};
