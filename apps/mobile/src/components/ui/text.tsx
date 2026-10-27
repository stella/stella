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
  variant = "default",
  ...props
}: TextInputProps & {
  className?: string;
  variant?: keyof typeof INPUT_VARIANTS;
}) => (
  <NativeTextInput
    className={`text-foreground font-sans text-base ${INPUT_VARIANTS[variant]} ${className ?? ""}`}
    cursorColorClassName="accent-foreground"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-ring"
    {...props}
  />
);
