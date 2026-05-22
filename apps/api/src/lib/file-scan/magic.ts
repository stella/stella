/**
 * Magic-byte signatures for binary upload types with a stable,
 * well-known header. Used to verify a client-declared media type
 * against the actual file bytes: a declared type that contradicts
 * the magic bytes is rejected before the file is stored or rendered.
 *
 * ZIP-based Office formats (DOCX/XLSX/PPTX) are covered separately by
 * `hasZipMagic`. Text formats (`text/plain`, `text/csv`,
 * `text/markdown`) and SVG have no reliable binary signature and are
 * intentionally absent — an unknown declared type is treated as a
 * match so this check never blocks a format it cannot reason about.
 */

const startsWith = (
  buffer: Uint8Array,
  signature: readonly number[],
): boolean => {
  if (buffer.length < signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }
  return true;
};

// `RIFF....WEBP`: the container tag is at offset 0, the form type at
// offset 8 (bytes 4-7 hold the little-endian file size).
const WEBP_RIFF_TAG = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_FORM_TYPE = [0x57, 0x45, 0x42, 0x50] as const;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;

const MIME_MAGIC_MATCHERS: Record<string, (buffer: Uint8Array) => boolean> = {
  // %PDF-
  "application/pdf": (buffer) => startsWith(buffer, PDF_SIGNATURE),
  // \x89 P N G \r \n \x1a \n
  "image/png": (buffer) => startsWith(buffer, PNG_SIGNATURE),
  // JPEG start-of-image marker
  "image/jpeg": (buffer) => startsWith(buffer, JPEG_SIGNATURE),
  // GIF87a / GIF89a
  "image/gif": (buffer) => startsWith(buffer, GIF_SIGNATURE),
  "image/webp": (buffer) =>
    startsWith(buffer, WEBP_RIFF_TAG) &&
    startsWith(buffer.subarray(8), WEBP_FORM_TYPE),
};

/**
 * Returns `false` only when `declaredMimeType` has a known magic-byte
 * signature and `buffer` does not match it. Unknown declared types
 * (text, ZIP-based Office formats handled elsewhere) return `true`.
 */
export const declaredMimeMatchesMagic = (
  declaredMimeType: string,
  buffer: Uint8Array,
): boolean => {
  const matcher = MIME_MAGIC_MATCHERS[declaredMimeType.toLowerCase()];
  if (!matcher) {
    return true;
  }
  return matcher(buffer);
};
