/**
 * URL sanitization with branded type safety.
 *
 * `SafeHref` is a branded string that can only be produced by
 * `sanitizeUrl`. Components that render `<a href>` should
 * accept `SafeHref` instead of raw strings, making it
 * structurally impossible to render an unsanitized URL.
 */

export type SafeHref = string & { readonly __brand: "SafeHref" };

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

  // SAFETY: URL has been validated as http/https
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return trimmed as SafeHref;
};

/** Empty-string sentinel typed as `SafeHref` for fallback cases. */
// SAFETY: empty string is trivially safe (renders as no-op href)
// eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
export const SAFE_HREF_EMPTY = "" as SafeHref;
