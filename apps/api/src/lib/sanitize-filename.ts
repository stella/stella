import * as v from "valibot";

/**
 * Branded type for filenames that have been sanitized.
 *
 * All code that stores a filename (JSONB `content.fileName`,
 * `desktopEditSessions.fileName`, `templates.fileName`, etc.)
 * must accept `SanitizedFileName`. The only way to obtain one
 * is via `sanitizeFilename()`, so the type system enforces that
 * every write path passes through sanitization.
 */
const sanitizedFileNameSchema = v.pipe(
  v.string(),
  v.brand("SanitizedFileName"),
);

export type SanitizedFileName = v.InferOutput<typeof sanitizedFileNameSchema>;

/**
 * Strip characters that could inject into Content-Disposition
 * or cause path-traversal issues on downstream systems.
 */
// eslint-disable-next-line no-control-regex -- intentional: strip null byte and other unsafe characters
const UNSAFE_CHARS_RE = /["/\\<>\r\n\0|*?:]/gu;
const PATH_TRAVERSAL_RE = /\.\./gu;

const stripLeadingAndTrailingDots = (name: string): string => {
  let start = 0;
  let end = name.length;

  while (name[start] === ".") {
    start += 1;
  }
  while (end > start && name[end - 1] === ".") {
    end -= 1;
  }

  const leadingReplacement = start > 0 ? "_" : "";
  const trailingReplacement = end < name.length ? "_" : "";
  return `${leadingReplacement}${name.slice(start, end)}${trailingReplacement}`;
};

export const sanitizeFilename = (name: string): SanitizedFileName => {
  const sanitized = name
    .replace(UNSAFE_CHARS_RE, "_")
    .replace(PATH_TRAVERSAL_RE, "__");
  const sanitizedWithoutEdgeDots = stripLeadingAndTrailingDots(sanitized);

  return v.parse(
    sanitizedFileNameSchema,
    sanitizedWithoutEdgeDots.slice(0, 255) || "file",
  );
};

/** Matches a trailing `.docx` extension (case-insensitive). */
export const DOCX_EXT_RE = /\.docx$/iu;
