const ASCII_FILENAME_RE = /^[\u0020-\u007E]+$/u;
const HTTP_CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F-\u009F]/gu;
const FALLBACK_FILENAME = "attachment";

/**
 * Build a Content-Disposition header value per RFC 6266.
 *
 * ASCII-safe filenames (no `"` or `\`) use the simple
 * `filename="..."` form. All others get a sanitised ASCII
 * fallback plus `filename*=UTF-8''...` for correct decoding.
 */
export const contentDisposition = (
  name: string,
  disposition: "attachment" | "inline" = "attachment",
): string => {
  const headerSafeName =
    name.replaceAll(HTTP_CONTROL_CHARACTER_RE, "") || FALLBACK_FILENAME;
  const isSafeAscii =
    ASCII_FILENAME_RE.test(headerSafeName) &&
    !headerSafeName.includes('"') &&
    !headerSafeName.includes("\\");

  if (isSafeAscii) {
    return `${disposition}; filename="${headerSafeName}"`;
  }

  // Sanitise fallback: strip non-ASCII and unsafe chars
  const fallback = headerSafeName
    .replaceAll(/[^\u0020-\u007E]/gu, "_")
    .replaceAll('"', "_")
    .replaceAll("\\", "_");
  const encoded = encodeURIComponent(headerSafeName).replaceAll("'", "%27");

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
