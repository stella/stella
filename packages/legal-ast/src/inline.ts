import * as v from "valibot";

export type InlineText = {
  type: "text";
  text: string;
  /** True when this text was anonymized by the publishing authority. */
  anonymized?: true | undefined;
};

export type InlineBold = { type: "bold"; children: Inline[] };
export type InlineItalic = { type: "italic"; children: Inline[] };
export type InlineLink = { type: "link"; href: string; children: Inline[] };
export type InlineLineBreak = { type: "line-break" };

/**
 * A reporter page boundary at this exact point in the text. Contributes
 * ZERO characters to the plain-text axis: the published page break is
 * typography, not content — it may fall mid-word, and the word must stay
 * whole for search, offsets and copying. Renderers show the label as
 * out-of-band chrome (a margin marker, a tick).
 */
export type InlinePageAnchor = {
  type: "page-anchor";
  /** The page number as printed ("495"). */
  label: string;
  /** Link to the official page scan, when one exists. */
  href?: string | undefined;
};

export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineLink
  | InlineLineBreak
  | InlinePageAnchor;

/** The inline kinds that nest children. */
export type InlineWithChildren = InlineBold | InlineItalic | InlineLink;

export const hasInlineChildren = (
  inline: Inline,
): inline is InlineWithChildren =>
  inline.type === "bold" || inline.type === "italic" || inline.type === "link";

export const inlineSchema: v.GenericSchema<Inline> = v.variant("type", [
  v.object({
    type: v.literal("text"),
    text: v.string(),
    anonymized: v.optional(v.literal(true)),
  }),
  v.object({
    type: v.literal("bold"),
    children: v.array(v.lazy(() => inlineSchema)),
  }),
  v.object({
    type: v.literal("italic"),
    children: v.array(v.lazy(() => inlineSchema)),
  }),
  v.object({
    type: v.literal("link"),
    href: v.string(),
    children: v.array(v.lazy(() => inlineSchema)),
  }),
  v.object({ type: v.literal("line-break") }),
  v.object({
    type: v.literal("page-anchor"),
    label: v.string(),
    href: v.optional(v.string()),
  }),
]);

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));

export const isInlineArray = (val: unknown): val is Inline[] =>
  v.is(inlineArraySchema, val);

export const isInline = (val: unknown): val is Inline =>
  v.is(inlineSchema, val);

export const flattenInlineText = (inlines: readonly Inline[]): string => {
  const parts: string[] = [];

  for (const inline of inlines) {
    if (inline.type === "text") {
      parts.push(inline.text);
      continue;
    }

    if (inline.type === "line-break") {
      parts.push("\n");
      continue;
    }

    if (inline.type === "page-anchor") {
      // Typography, not content: zero characters on the text axis.
      continue;
    }

    parts.push(flattenInlineText(inline.children));
  }

  return parts.join("");
};
