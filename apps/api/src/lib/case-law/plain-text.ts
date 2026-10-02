import { Result, TaggedError } from "better-result";
import { decodeHTMLStrict } from "entities";
import * as v from "valibot";

import {
  containsTagLikeMarkup,
  TAG_LIKE_MARKUP_SOURCE,
} from "@/api/lib/case-law/plain-text-markup";
import {
  approvedMetadataUrl,
  preserveMetadataUrlDeclarations,
} from "@/api/lib/legal-search/metadata-urls";
import type { SafeHref } from "@/api/lib/sanitize-url";
import { isRecord } from "@/api/lib/type-guards";

const plainTextBrand = Symbol("PlainText");
const plainTextSchema = v.pipe(v.string(), v.brand(plainTextBrand));
export type PlainText = v.InferOutput<typeof plainTextSchema>;

export type PlainTextMetadataValue =
  | PlainText
  | SafeHref
  | number
  | boolean
  | null
  | undefined
  | readonly PlainTextMetadataValue[]
  | { readonly [key: string]: PlainTextMetadataValue };

export class PlainTextError extends TaggedError("PlainTextError")<{
  message: string;
  reason:
    | "rtf-syntax"
    | "unsupported-metadata"
    | "empty-present-text"
    | "entity-decode-failed";
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
    const encoded = text;
    const decoded = Result.try({
      try: () => decodeHTMLStrict(encoded),
      catch: () =>
        new PlainTextError({
          message: "HTML entity decoding failed for a plain-text field",
          reason: "entity-decode-failed",
        }),
    });
    if (decoded.isErr()) {
      return decoded;
    }
    const normalized = decoded.value
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+/gu, " ")
      .split("\n")
      .map((line) => line.replace(/^ | $/gu, ""))
      .join("\n")
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
  return Result.ok(v.parse(plainTextSchema, text));
};

export const toPlainTextMetadata = (
  value: unknown,
): Result<PlainTextMetadataValue, PlainTextError> => {
  if (typeof value === "string") {
    return toPlainText(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return Result.ok(value);
  }
  if (Array.isArray(value)) {
    return Result.all(
      value.map((entry: unknown, index) => {
        const approved = approvedMetadataUrl(value, String(index));
        return approved === undefined
          ? toPlainTextMetadata(entry)
          : Result.ok(approved);
      }),
    ).map((plain) => preserveMetadataUrlDeclarations(value, plain));
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return toPlainTextMetadataObject(value);
  }
  return Result.err(
    new PlainTextError({
      message: "Plain-text metadata must contain only JSON values",
      reason: "unsupported-metadata",
    }),
  );
};

/** Project the container as a whole so exact URL declarations remain attached. */
export const toPlainTextMetadataObject = (
  value: Record<string, unknown>,
): Result<Record<string, PlainTextMetadataValue>, PlainTextError> =>
  Result.all(
    Object.entries(value).map(([key, entry]) => {
      const approved = approvedMetadataUrl(value, key);
      const projected =
        approved === undefined
          ? toPlainTextMetadata(entry)
          : Result.ok(approved);
      return projected.map((plain) => [key, plain] as const);
    }),
  ).map((entries) =>
    preserveMetadataUrlDeclarations(value, Object.fromEntries(entries)),
  );
