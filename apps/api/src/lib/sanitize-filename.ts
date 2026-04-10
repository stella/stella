/**
 * Strip characters that could inject into Content-Disposition
 * or cause path-traversal issues on downstream systems.
 */
// eslint-disable-next-line no-control-regex -- intentional: strip null byte and other unsafe characters
const UNSAFE_CHARS_RE = /["/\\<>\r\n\0|*?:]/g;
const PATH_TRAVERSAL_RE = /\.\./g;
const LEADING_TRAILING_DOTS_RE = /^\.+|\.+$/g;

export const sanitizeFilename = (name: string) => {
  const sanitized = name
    .replace(UNSAFE_CHARS_RE, "_")
    .replace(PATH_TRAVERSAL_RE, "__")
    .replace(LEADING_TRAILING_DOTS_RE, "_");

  return sanitized.slice(0, 255) || "file";
};

/** Matches a trailing `.docx` extension (case-insensitive). */
export const DOCX_EXT_RE = /\.docx$/i;
