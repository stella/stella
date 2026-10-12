/** Drops characters XML 1.0 cannot carry at all, even escaped. */
const isXmlChar = (codePoint: number): boolean =>
  codePoint === 0x9 ||
  codePoint === 0xa ||
  codePoint === 0xd ||
  (codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
  (codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
  (codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff);

const stripInvalidXmlChars = (value: string): string =>
  Array.from(value)
    .filter((char) => isXmlChar(char.codePointAt(0) ?? 0))
    .join("");

const escapeXml = (value: string): string =>
  stripInvalidXmlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** An element's children: nested nodes, or nothing for an omitted element. */
export type XmlContent = string | null | undefined | false | XmlContent[];

type XmlAttributes = Record<string, string | null | undefined>;

const attributesText = (attributes: XmlAttributes | undefined): string =>
  Object.entries(attributes ?? {})
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && entry[1] !== undefined,
    )
    .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
    .join("");

const flatten = (node: XmlContent): string => {
  if (Array.isArray(node)) {
    return node.map(flatten).join("");
  }
  return typeof node === "string" ? node : "";
};

/** An element wrapping other elements; omitted when it has no content. */
export const el = (
  name: string,
  children: XmlContent,
  attributes?: XmlAttributes,
): string => {
  const inner = flatten(children);
  return inner === "" && attributes === undefined
    ? ""
    : `<${name}${attributesText(attributes)}>${inner}</${name}>`;
};

/** A text element; omitted when the value is absent or blank. */
export const text = (
  name: string,
  value: string | number | boolean | null | undefined,
  attributes?: XmlAttributes,
): string => {
  if (value === null || value === undefined) {
    return "";
  }
  const rendered = String(value);
  return rendered.trim() === ""
    ? ""
    : `<${name}${attributesText(attributes)}>${escapeXml(rendered)}</${name}>`;
};

/** A text element the schema requires, emitted even when empty. */
export const mandatoryText = (
  name: string,
  value: string | number | null | undefined,
  attributes?: XmlAttributes,
): string =>
  `<${name}${attributesText(attributes)}>${escapeXml(value === null || value === undefined ? "" : String(value))}</${name}>`;

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
