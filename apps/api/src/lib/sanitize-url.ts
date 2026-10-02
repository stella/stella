// parser-output-unchanged: adds a typed constructor; existing callers are unaffected
import { TaggedError } from "better-result";
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

export type MetadataUrlEncoding = "transport-json" | "decoded" | "constructed";

export const METADATA_URL_DEFECT_REASONS = [
  "control-character",
  "invalid-url",
  "unsafe-protocol",
  "unsupported-url-value",
] as const;

export class MetadataUrlDefect extends TaggedError("MetadataUrlDefect")<{
  message: string;
  reason: (typeof METADATA_URL_DEFECT_REASONS)[number];
}> {}

/** Metadata transports already own decoding; preserve their scalar URL spelling. */
export function toMetadataUrl(
  raw: string,
  encoding: MetadataUrlEncoding,
): SafeHref | MetadataUrlDefect | undefined;
export function toMetadataUrl(raw: null, encoding: MetadataUrlEncoding): null;
export function toMetadataUrl(
  raw: undefined,
  encoding: MetadataUrlEncoding,
): undefined;
export function toMetadataUrl(
  raw: string | null | undefined,
  encoding: MetadataUrlEncoding,
): SafeHref | MetadataUrlDefect | null | undefined;
export function toMetadataUrl(
  raw: string | null | undefined,
  _encoding: MetadataUrlEncoding,
): SafeHref | MetadataUrlDefect | null | undefined {
  if (raw === null || raw === undefined) {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (/\p{Cc}/u.test(trimmed) || stripDangerousChars(trimmed) !== trimmed) {
    return new MetadataUrlDefect({
      message: "Metadata URL contains a dangerous character",
      reason: "control-character",
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
}

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
