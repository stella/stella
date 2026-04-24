/**
 * Validates that a URL uses a safe scheme (http or https).
 *
 * Rejects `javascript:`, `data:`, `vbscript:`, and any other
 * non-HTTP scheme that could lead to XSS when rendered as an
 * `<a href>` in the browser.
 */
export const sanitizeUrl = (url: string): string | undefined => {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
};
