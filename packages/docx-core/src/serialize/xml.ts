export const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const attr = (
  name: string,
  value: string | number | boolean | undefined,
) => (value === undefined ? "" : ` ${name}="${escapeXml(String(value))}"`);
