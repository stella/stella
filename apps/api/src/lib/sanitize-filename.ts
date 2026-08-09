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
const UNSAFE_CHARS_RE = /["/\\<>\r\n\0|*?:]/gu;
const PATH_TRAVERSAL_RE = /\.\./gu;
const MAX_FILENAME_LENGTH = 255;

const truncateUnicode = (value: string, maxLength: number): string => {
  const characters: string[] = [];
  let length = 0;
  for (const character of value) {
    if (length + character.length > maxLength) {
      break;
    }
    characters.push(character);
    length += character.length;
  }
  return characters.join("");
};

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
    .toWellFormed()
    .replace(UNSAFE_CHARS_RE, "_")
    .replace(PATH_TRAVERSAL_RE, "__");
  const sanitizedWithoutEdgeDots = stripLeadingAndTrailingDots(sanitized);

  return v.parse(
    sanitizedFileNameSchema,
    truncateUnicode(sanitizedWithoutEdgeDots, MAX_FILENAME_LENGTH) || "file",
  );
};

/**
 * Sanitize a filename while preserving its extension. The base name is
 * truncated, not the extension, when the total exceeds 255 characters.
 */
export const sanitizeFilenamePreservingExtension = (
  name: string,
): SanitizedFileName => {
  const wellFormedName = name.toWellFormed();
  const lastDot = wellFormedName.lastIndexOf(".");
  if (lastDot === -1) {
    return sanitizeFilename(wellFormedName);
  }

  const extension = wellFormedName.slice(lastDot);
  const sanitizedBase = sanitizeFilename(wellFormedName.slice(0, lastDot));
  const maxBaseLength = MAX_FILENAME_LENGTH - extension.length;

  if (maxBaseLength <= 0) {
    return sanitizeFilename(wellFormedName);
  }

  return sanitizeFilename(
    truncateUnicode(sanitizedBase, maxBaseLength) + extension,
  );
};

/** Matches a trailing `.docx` extension (case-insensitive). */
export const DOCX_EXT_RE = /\.docx$/iu;
