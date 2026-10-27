import { Text as NativeText, TextInput as NativeTextInput } from "react-native";
import type { TextInputProps, TextProps } from "react-native";

/**
 * Type roles, in the web's Tailwind sizes, so a heading on the phone reads as
 * one on the web does.
 */
const TEXT_VARIANTS = {
  body: "text-base",
  /** A list row's name: body size, medium weight. */
  rowTitle: "text-base font-medium",
  caption: "text-sm text-muted-foreground",
  /** A notice that something failed. */
  error: "text-sm text-destructive-foreground",
  label: "text-sm font-medium",
  /** The small capitals over a group of rows, as iOS settings set them. */
  section: "text-xs font-medium uppercase text-muted-foreground",
  headline: "text-lg font-semibold",
  title: "text-2xl font-semibold",
  largeTitle: "text-3xl font-bold tracking-tight",
} as const;

export type TextVariant = keyof typeof TEXT_VARIANTS;

/** The app's text: DM Sans in the web's foreground, at a role's size. */
export const Text = ({
  className,
  variant = "body",
  ...props
}: TextProps & { className?: string; variant?: TextVariant }) => (
  <NativeText
    className={`text-foreground font-sans ${TEXT_VARIANTS[variant]} ${className ?? ""}`}
    {...props}
  />
);

/** A text field with the web's input look: hairline border, card fill. */
export const TextInput = ({
  className,
  ...props
}: TextInputProps & { className?: string }) => (
  <NativeTextInput
    className={`border-input bg-card text-foreground min-h-11 rounded-lg border px-3 font-sans text-base ${className ?? ""}`}
    cursorColorClassName="accent-foreground"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-ring"
    {...props}
  />
);
