import * as v from "valibot";

/**
 * URL sanitization with branded type safety.
 *
 * `SafeHref` is a branded string that can only be produced by
 * `sanitizeUrl`. Components that render `<a href>` should
 * accept `SafeHref` instead of raw strings, making it
 * structurally impossible to render an unsanitized URL.
 */

const safeHrefSchema = v.pipe(v.string(), v.brand("SafeHref"));

export type SafeHref = v.InferOutput<typeof safeHrefSchema>;

/**
 * Validate that a URL uses a safe protocol (http/https).
 * Returns a branded `SafeHref` on success, `undefined` on failure.
 */
export const sanitizeUrl = (
  url: string | null | undefined,
): SafeHref | undefined => {
  if (!url) {
    return undefined;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!URL.canParse(trimmed)) {
    return undefined;
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  return v.parse(safeHrefSchema, trimmed);
};

/** Empty-string sentinel typed as `SafeHref` for fallback cases. */
export const SAFE_HREF_EMPTY = v.parse(safeHrefSchema, "");
