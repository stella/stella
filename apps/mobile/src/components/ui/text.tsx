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
  /** The sign-in's heading: the web auth panel's light 2rem title. */
  display: "text-[32px] leading-[37px] tracking-tight",
  /** A small bordered tag in capitals, as the web marks the beta. */
  badge: "text-[10px] uppercase tracking-[1px] text-muted-foreground",
  /** An inline link in a caption, underlined as the web's legal links are. */
  link: "text-sm text-muted-foreground underline",
  /**
   * A decision's text, in the reader's serif at its 1.65 leading
   * (packages/decision-reader reader.css). Its emphases nest inside it and
   * keep its size.
   */
  reading: "text-base leading-[26px]",
  readingStrong: "",
  readingEmphasis: "",
  readingStrongEmphasis: "",
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
  display: "DMSans-Light",
  badge: "DMSans-Medium",
  link: "DMSans-Regular",
  // The web reader sets Source Serif 4, which ships only as web fonts; iOS's
  // own Georgia is the serif the phone has.
  reading: "Georgia",
  readingStrong: "Georgia-Bold",
  readingEmphasis: "Georgia-Italic",
  readingStrongEmphasis: "Georgia-BoldItalic",
} as const satisfies Record<keyof typeof TEXT_VARIANTS, string>;

export type TextVariant = keyof typeof TEXT_VARIANTS;

/** `text-` utilities that set a size, alignment or wrapping rather than a colour. */
const NOT_A_COLOUR =
  /^text-(?:xs|sm|base|lg|\d*xl|\[|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)/u;

/**
 * `classes` with the foreground colour first, unless they name a colour of
 * their own. Both would be one utility, and the stylesheet orders them by
 * name, so `text-foreground` would win over `text-destructive` whatever
 * order they were written in.
 */
const withForeground = (classes: string): string =>
  classes
    .split(/\s+/u)
    .some((name) => name.startsWith("text-") && !NOT_A_COLOUR.test(name))
    ? classes
    : `text-foreground ${classes}`;

/** The app's text: DM Sans in the web's foreground, at a role's size. */
export const Text = ({
  className,
  style,
  variant = "body",
  ...props
}: TextProps & { className?: string; variant?: TextVariant }) => (
  <NativeText
    style={[{ fontFamily: FACES[variant] }, style]}
    className={withForeground(`${TEXT_VARIANTS[variant]} ${className ?? ""}`)}
    {...props}
  />
);

const INPUT_VARIANTS = {
  /** The web's input: hairline border, card fill. */
  default: "min-h-11 rounded-lg border border-input bg-card px-3 text-base",
  /** A search field, filled and borderless, as iOS lists set one. */
  search: "min-h-10 rounded-xl bg-secondary px-3 text-base",
  /** No box of its own, for a field inside a container that draws one. */
  bare: "min-h-9 py-2 text-base",
  /**
   * The composer's text: the web's `COMPOSER_TEXT_CLASS` stature (text-sm at
   * leading-5) with no box, inside the composer's text cell.
   */
  composer: "p-0 text-sm leading-5",
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
    className={withForeground(`${INPUT_VARIANTS[variant]} ${className ?? ""}`)}
    cursorColorClassName="accent-foreground"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-ring"
    {...props}
  />
);
