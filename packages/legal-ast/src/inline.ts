const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

export type InlineText = {
  type: "text";
  text: string;
  /** True when this text was anonymized by the publishing authority. */
  anonymized?: true;
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

export const isInlineArray = (val: unknown): val is Inline[] =>
  Array.isArray(val) && val.every(isInline);

export const isInline = (val: unknown): val is Inline => {
  if (!isRecord(val) || typeof val["type"] !== "string") {
    return false;
  }

  if (val["type"] === "text") {
    return (
      typeof val["text"] === "string" &&
      (val["anonymized"] === undefined || val["anonymized"] === true)
    );
  }

  if (val["type"] === "bold" || val["type"] === "italic") {
    return isInlineArray(val["children"]);
  }

  if (val["type"] === "link") {
    return typeof val["href"] === "string" && isInlineArray(val["children"]);
  }

  return val["type"] === "line-break";
};

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
