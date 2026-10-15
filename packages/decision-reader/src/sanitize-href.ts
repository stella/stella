/** One leading slash, and the next character starts the path. */
const SAFE_APP_PATH = /^\/(?![\\/])/u;

/**
 * Sanitize a URL for use in `<a href>` attributes.
 *
 * Rejects `javascript:`, `data:`, `vbscript:`, and other
 * dangerous protocols. Allows web URLs, in-app paths, fragment
 * links, and mail links. Returns `undefined` for unsafe URLs so
 * the caller can fall back to plain text rendering.
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

  // Fragment-only links are safe.
  if (trimmed.startsWith("#")) {
    return trimmed;
  }

  // An in-app path is safe; a scheme-relative URL is not, and the two are a
  // slash apart. `//host/p` reads as a path and resolves to `https://host/p`,
  // which is how a value that passed this check leaves the origin — and
  // browsers normalise a backslash to a separator, so `/\host` does the same.
  // Exactly one leading slash, then neither.
  if (SAFE_APP_PATH.test(trimmed)) {
    return trimmed;
  }

  if (!URL.canParse(trimmed)) {
    return undefined;
  }

  const parsed = new URL(trimmed);
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "mailto:"
  ) {
    return undefined;
  }

  return trimmed;
};
