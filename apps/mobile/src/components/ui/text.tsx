import { Text as NativeText, TextInput as NativeTextInput } from "react-native";
import type { TextInputProps, TextProps } from "react-native";

/**
 * Type roles, in the web's Tailwind sizes, so a heading on the phone reads as
 * one on the web does.
 */
const TEXT_VARIANTS = {
  body: "text-base",
  /** A list row's name: body size, medium weight. */
  rowTitle: "text-base",
  caption: "text-sm text-muted-foreground",
  /** A notice that something failed. */
  error: "text-sm text-destructive-foreground",
  label: "text-sm",
  /** A button's label: body size, medium weight. */
  button: "text-base",
  /** The small capitals over a group of rows, as iOS settings set them. */
  section: "text-xs uppercase text-muted-foreground",
  headline: "text-lg",
  title: "text-2xl",
  largeTitle: "text-3xl tracking-tight",
} as const;

/**
 * The DM Sans face each role is set in. Every weight is its own embedded
 * font, and iOS does not derive one from a weight, so the face is named.
 */
const FACES = {
  body: "DMSans-Regular",
  rowTitle: "DMSans-Medium",
  caption: "DMSans-Regular",
  error: "DMSans-Regular",
  label: "DMSans-Medium",
  button: "DMSans-Medium",
  section: "DMSans-Medium",
  headline: "DMSans-SemiBold",
  title: "DMSans-SemiBold",
  largeTitle: "DMSans-Bold",
} as const satisfies Record<keyof typeof TEXT_VARIANTS, string>;

export type TextVariant = keyof typeof TEXT_VARIANTS;

/** The app's text: DM Sans in the web's foreground, at a role's size. */
export const Text = ({
  className,
  style,
  variant = "body",
  ...props
}: TextProps & { className?: string; variant?: TextVariant }) => (
  <NativeText
    style={[{ fontFamily: FACES[variant] }, style]}
    className={`text-foreground ${TEXT_VARIANTS[variant]} ${className ?? ""}`}
    {...props}
  />
);

const INPUT_VARIANTS = {
  /** The web's input: hairline border, card fill. */
  default: "min-h-11 rounded-lg border border-input bg-card px-3",
  /** A search field, filled and borderless, as iOS lists set one. */
  search: "min-h-10 rounded-xl bg-secondary px-3",
  /** No box of its own, for a field inside a container that draws one. */
  bare: "min-h-9 py-2",
} as const;

/** A text field in the web's type, in one of the app's input shapes. */
export const TextInput = ({
  className,
  style,
  variant = "default",
  ...props
}: TextInputProps & {
  className?: string;
  variant?: keyof typeof INPUT_VARIANTS;
}) => (
  <NativeTextInput
    style={[{ fontFamily: "DMSans-Regular" }, style]}
    className={`text-foreground text-base ${INPUT_VARIANTS[variant]} ${className ?? ""}`}
    cursorColorClassName="accent-foreground"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-ring"
    {...props}
  />
);
