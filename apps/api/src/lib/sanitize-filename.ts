/**
 * Branded type for filenames that have been sanitized.
 *
 * All code that stores a filename (JSONB `content.fileName`,
 * `desktopEditSessions.fileName`, `templates.fileName`, etc.)
 * must accept `SanitizedFileName`. The only way to obtain one
 * is via `sanitizeFilename()`, so the type system enforces that
 * every write path passes through sanitization.
 */
export type SanitizedFileName = string & {
  readonly __brand: "SanitizedFileName";
};

/**
 * Strip characters that could inject into Content-Disposition
 * or cause path-traversal issues on downstream systems.
 */
// eslint-disable-next-line no-control-regex -- intentional: strip null byte and other unsafe characters
const UNSAFE_CHARS_RE = /["/\\<>\r\n\0|*?:]/g;
const PATH_TRAVERSAL_RE = /\.\./g;
const LEADING_TRAILING_DOTS_RE = /^\.+|\.+$/g;

export const sanitizeFilename = (name: string): SanitizedFileName => {
  const sanitized = name
    .replace(UNSAFE_CHARS_RE, "_")
    .replace(PATH_TRAVERSAL_RE, "__")
    .replace(LEADING_TRAILING_DOTS_RE, "_");

  // SAFETY: the sanitization above guarantees the result is safe
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  return (sanitized.slice(0, 255) || "file") as SanitizedFileName;
};

/** Matches a trailing `.docx` extension (case-insensitive). */
export const DOCX_EXT_RE = /\.docx$/i;
