// parser-output-unchanged: adds a typed constructor; existing callers are unaffected
import { Result, TaggedError } from "better-result";
import { decodeHTMLAttribute } from "entities";
import * as v from "valibot";

import { stripDangerousChars } from "@stll/legal-ast/text-sanitize";

/**
 * URL sanitization with branded type safety.
 *
 * `SafeHref` is a branded string that can only be produced by
 * the shared URL constructors. Components that render `<a href>` should
 * accept `SafeHref` instead of raw strings, making it
 * structurally impossible to render an unsanitized URL.
 */

const safeHrefBrand = Symbol("SafeHref");
const safeHrefSchema = v.pipe(v.string(), v.brand(safeHrefBrand));

export type SafeHref = v.InferOutput<typeof safeHrefSchema>;

export type MetadataUrlEncoding =
  | "transport-json"
  | "decoded"
  | "constructed"
  | "raw-html";

export const METADATA_URL_DEFECT_REASONS = [
  "empty-url",
  "control-character",
  "invalid-url",
  "unsafe-protocol",
  "entity-decode-failed",
  "unsupported-url-value",
] as const;

export class MetadataUrlDefect extends TaggedError("MetadataUrlDefect")<{
  message: string;
  reason: (typeof METADATA_URL_DEFECT_REASONS)[number];
}> {}

/** Decode only a literal HTML attribute; all other producers already own decoding. */
export const toMetadataUrl = (
  raw: string | null | undefined,
  encoding: MetadataUrlEncoding,
): SafeHref | MetadataUrlDefect | undefined => {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  let value = raw;
  if (encoding === "raw-html") {
    const decoded = Result.try({
      try: () => decodeHTMLAttribute(raw),
      catch: () =>
        new MetadataUrlDefect({
          message: "Metadata URL entity decoding failed",
          reason: "entity-decode-failed",
        }),
    });
    if (decoded.isErr()) {
      return decoded.error;
    }
    value = decoded.value;
  }
  const trimmed = value.trim();
  if (/\p{Cc}/u.test(trimmed) || stripDangerousChars(trimmed) !== trimmed) {
    return new MetadataUrlDefect({
      message: "Metadata URL contains a dangerous character",
      reason: "control-character",
    });
  }
  if (trimmed.length === 0) {
    return new MetadataUrlDefect({
      message: "Metadata URL is empty",
      reason: "empty-url",
    });
  }
  if (!URL.canParse(trimmed)) {
    return new MetadataUrlDefect({
      message: "Metadata URL cannot be parsed",
      reason: "invalid-url",
    });
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new MetadataUrlDefect({
      message: "Metadata URL uses an unsafe protocol",
      reason: "unsafe-protocol",
    });
  }
  return v.parse(safeHrefSchema, trimmed);
};

export const sanitizeUrl = (
  url: string | null | undefined,
): SafeHref | undefined => {
  if (!url) {
    return undefined;
  }
  const trimmed = url.trim();
  if (!trimmed || !URL.canParse(trimmed)) {
    return undefined;
  }
  const parsed = new URL(trimmed);
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? v.parse(safeHrefSchema, trimmed)
    : undefined;
};

/** Empty-string sentinel typed as `SafeHref` for fallback cases. */
export const SAFE_HREF_EMPTY = v.parse(safeHrefSchema, "");
