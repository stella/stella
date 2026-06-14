// XML 1.0 legal characters: tab, LF, CR, #x20-#xD7FF, #xE000-#xFFFD, and the
// astral planes (#x10000-#x10FFFF). Anything else makes a DOCX that Word refuses
// to open, so it is dropped before escaping.
const ILLEGAL_XML_CHARS_RE =
  // eslint-disable-next-line no-control-regex -- XML 1.0 explicitly allows tab, LF and CR.
  /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const stripIllegalXmlChars = (value: string): string =>
  value.replace(ILLEGAL_XML_CHARS_RE, "");

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
