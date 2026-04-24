/**
 * Sanitize a URL for use in `<a href>` attributes.
 *
 * Rejects `javascript:`, `data:`, `vbscript:`, and other
 * dangerous protocols. Returns `undefined` for unsafe URLs
 * so the caller can fall back to plain text rendering.
 */
export const sanitizeHref = (
  url: string | null | undefined,
): string | undefined => {
  if (!url) {
    return undefined;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }

  // Relative URLs and fragment-only links are safe
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) {
    return trimmed;
  }

  if (!URL.canParse(trimmed)) {
    return undefined;
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  return trimmed;
};
