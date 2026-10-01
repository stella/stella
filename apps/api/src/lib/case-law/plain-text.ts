import { Result, TaggedError } from "better-result";
import { decodeHTMLStrict } from "entities";

import {
  containsTagLikeMarkup,
  TAG_LIKE_MARKUP_SOURCE,
} from "@/api/lib/case-law/plain-text-markup";

declare const plainTextBrand: unique symbol;
export type PlainText = string & { readonly [plainTextBrand]: true };

export type PlainTextMetadataValue =
  | PlainText
  | number
  | boolean
  | null
  | undefined
  | readonly PlainTextMetadataValue[]
  | { readonly [key: string]: PlainTextMetadataValue };

export class PlainTextError extends TaggedError("PlainTextError")<{
  message: string;
  reason: "rtf-syntax" | "unsupported-metadata" | "empty-present-text";
}> {}

const TAG = new RegExp(TAG_LIKE_MARKUP_SOURCE, "gu");
const RTF_SYNTAX = /\\(?:[A-Za-z]+-?\d*\b|'[0-9a-fA-F]{2})/u;
const MARKUP_SECTION =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<\?[A-Za-z][\s\S]*?(?:\?>|$)/gu;

/** Presentation structure is removed; undecodable RTF is rejected, never guessed. */
export const toPlainText = (raw: string): Result<PlainText, PlainTextError> => {
  let text = raw;
  // Every changed pass consumes an encoding or markup layer, so this terminates.
  for (;;) {
    const decoded = decodeHTMLStrict(text);
    const normalized = decoded
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    const stripped = containsTagLikeMarkup(normalized)
      ? normalized
          .replace(
            MARKUP_SECTION,
            (_match, cdata: string | undefined) => cdata ?? "",
          )
          .replace(TAG, " ")
      : normalized;
    if (stripped === text) {
      break;
    }
    text = stripped;
  }
  if (RTF_SYNTAX.test(text)) {
    return Result.err(
      new PlainTextError({
        message:
          "RTF syntax requires its source parser before entering a plain-text field",
        reason: "rtf-syntax",
      }),
    );
  }
  // Preserve paragraph breaks, following adapter text normalization.
  return Result.ok(text as PlainText);
};

/** Existing synchronous adapter assembly propagates a typed defect to its caller. */
export const requirePlainText = (raw: string): PlainText => {
  const result = toPlainText(raw);
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};

export const toPlainTextMetadata = (value: unknown): PlainTextMetadataValue => {
  if (typeof value === "string") {
    return requirePlainText(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toPlainTextMetadata);
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        toPlainTextMetadata(entry),
      ]),
    );
  }
  throw new PlainTextError({
    message: "Plain-text metadata must contain only JSON values",
    reason: "unsupported-metadata",
  });
};
