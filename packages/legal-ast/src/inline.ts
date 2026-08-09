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

export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineLink
  | InlineLineBreak;

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
]);

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));

export const isInlineArray = (val: unknown): val is Inline[] =>
  v.safeParse(inlineArraySchema, val).success;

export const isInline = (val: unknown): val is Inline =>
  v.safeParse(inlineSchema, val).success;

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

    parts.push(flattenInlineText(inline.children));
  }

  return parts.join("");
};
