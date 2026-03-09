const ASCII_FILENAME_RE = /^[\x20-\x7E]+$/;

/**
 * Build a Content-Disposition header value per RFC 6266.
 *
 * ASCII-safe filenames (no `"` or `\`) use the simple
 * `filename="..."` form. All others get a sanitised ASCII
 * fallback plus `filename*=UTF-8''...` for correct decoding.
 */
export const contentDisposition = (name: string): string => {
  const isSafeAscii =
    ASCII_FILENAME_RE.test(name) && !name.includes('"') && !name.includes("\\");

  if (isSafeAscii) {
    return `attachment; filename="${name}"`;
  }

  // Sanitise fallback: strip non-ASCII and unsafe chars
  const fallback = name
    .replaceAll(/[^\x20-\x7E]/g, "_")
    .replaceAll('"', "_")
    .replaceAll("\\", "_");
  const encoded = encodeURIComponent(name).replaceAll("'", "%27");

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
