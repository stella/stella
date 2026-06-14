// XML 1.0 legal characters: tab, LF, CR, #x20-#xD7FF, #xE000-#xFFFD, and the
// astral planes (#x10000-#x10FFFF). Anything else (e.g. C0 control bytes that
// leak in from source documents) makes a DOCX that Word refuses to open, so it
// is dropped before escaping. Code points are compared numerically to avoid
// authoring fragile literal control characters in the source.
const isLegalXmlCodePoint = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0d ||
  (code >= 0x20 && code <= 0xd7_ff) ||
  (code >= 0xe0_00 && code <= 0xff_fd) ||
  (code >= 0x1_00_00 && code <= 0x10_ff_ff);

const stripIllegalXmlChars = (value: string): string => {
  let cleaned = "";
  for (const char of value) {
    if (isLegalXmlCodePoint(char.codePointAt(0) ?? 0)) {
      cleaned += char;
    }
  }
  return cleaned;
};

export const escapeXml = (value: string): string =>
  stripIllegalXmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const attr = (
  name: string,
  value: string | number | boolean | undefined,
) => (value === undefined ? "" : ` ${name}="${escapeXml(String(value))}"`);
