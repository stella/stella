// The text primitive's contract, shared by its two renderers: the web's
// (./text.tsx, a <span>) and React Native's (./text.native.tsx). A role names
// what the text is for (a row's title, a caption, a section label); both
// renderers set it at the same Tailwind size and in the same face, so a
// heading on a phone reads as one on the web does.
//
// A browser derives a weight or an italic from one font family; a phone does
// not: every face is its own embedded font. So a role names its face as a
// family, a weight and a slant, and each renderer spells that its own way
// (`font-medium` on the web, the `DMSans-Medium` face on a phone).

import type { ReactNode } from "react";

/** Each role's size, colour and spacing, as Tailwind classes. */
export const TEXT_VARIANT_CLASS_NAMES = {
  body: "text-base",
  /** A list row's name. */
  rowTitle: "text-base",
  caption: "text-sm text-muted-foreground",
  /** A notice that something failed. */
  error: "text-sm text-destructive-foreground",
  label: "text-sm",
  /** A button's label. */
  button: "text-base",
  /** The small capitals over a group of rows. */
  section: "text-xs uppercase text-muted-foreground",
  headline: "text-lg",
  title: "text-2xl",
  /** A sign-in page's heading: the auth panel's light 2rem title. */
  display: "text-[32px] leading-[37px] tracking-tight",
  /** A small bordered tag in capitals, as the beta is marked. */
  badge: "text-[10px] uppercase tracking-[1px] text-muted-foreground",
  /** An inline link in a caption, underlined as legal links are. */
  link: "text-sm text-muted-foreground underline",
  /**
   * A court decision's text, in the reader's serif at its 1.65 leading
   * (packages/decision-reader reader.css). Its emphases nest inside it and
   * keep its size.
   */
  reading: "text-base leading-[26px]",
  readingStrong: "",
  readingEmphasis: "",
  readingStrongEmphasis: "",
} as const;

export type TextVariant = keyof typeof TEXT_VARIANT_CLASS_NAMES;

export type TextFace = {
  readonly family: "sans" | "serif";
  readonly weight: "light" | "regular" | "medium" | "semibold" | "bold";
  readonly italic?: true;
};

const sans = (weight: TextFace["weight"]): TextFace => ({
  family: "sans",
  weight,
});

/** The face each role is set in. */
export const TEXT_VARIANT_FACES = {
  body: sans("regular"),
  rowTitle: sans("medium"),
  caption: sans("regular"),
  error: sans("regular"),
  label: sans("medium"),
  button: sans("medium"),
  section: sans("medium"),
  headline: sans("semibold"),
  title: sans("semibold"),
  display: sans("light"),
  badge: sans("medium"),
  link: sans("regular"),
  reading: { family: "serif", weight: "regular" },
  readingStrong: { family: "serif", weight: "bold" },
  readingEmphasis: { family: "serif", weight: "regular", italic: true },
  readingStrongEmphasis: { family: "serif", weight: "bold", italic: true },
} as const satisfies Record<TextVariant, TextFace>;

/** The props every text renderer accepts, with one meaning. */
export type TextContract = {
  variant?: TextVariant;
  children?: ReactNode;
};
