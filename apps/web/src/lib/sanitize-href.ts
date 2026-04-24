/**
 * Returns the URL unchanged if it uses a safe scheme (http/https),
 * or `undefined` otherwise. Prevents `javascript:` and `data:`
 * URIs from reaching `<a href>`.
 */
export const sanitizeHref = (href: string): string | undefined => {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
};
