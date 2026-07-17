/**
 * Escape a string for safe use inside a double-quoted XML attribute value.
 * Order matters: `&` must be escaped first so it does not double-escape the
 * entities produced for the other characters.
 */
const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Find the next available rId in a relationships XML string */
export const findNextRId = (relsXml: string): string => {
  const matches = relsXml.matchAll(/Id="rId(?<num>\d+)"/gu);
  let max = 0;
  for (const m of matches) {
    const n = Number.parseInt(m.groups?.["num"] ?? "0", 10);
    if (n > max) {
      max = n;
    }
  }
  return `rId${max + 1}`;
};

/** Ensure a content type entry exists in [Content_Types].xml */
export const ensureContentType = (
  contentTypesXml: string,
  partName: string,
  contentType: string,
): string => {
  const escapedPartName = escapeXmlAttribute(partName);
  if (contentTypesXml.includes(`PartName="${escapedPartName}"`)) {
    return contentTypesXml;
  }
  const override = `<Override PartName="${escapedPartName}" ContentType="${escapeXmlAttribute(contentType)}"/>`;
  return contentTypesXml.replace("</Types>", () => `${override}\n</Types>`);
};

/** Ensure a relationship entry exists */
export const ensureRelationship = (
  relsXml: string,
  rId: string,
  type: string,
  target: string,
): string => {
  const escapedRId = escapeXmlAttribute(rId);
  if (relsXml.includes(`Id="${escapedRId}"`)) {
    return relsXml;
  }
  const rel = `<Relationship Id="${escapedRId}" Type="${escapeXmlAttribute(type)}" Target="${escapeXmlAttribute(target)}"/>`;
  return relsXml.replace("</Relationships>", () => `${rel}\n</Relationships>`);
};
