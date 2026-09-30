import * as slimdom from "slimdom";

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

const relationshipIds = (relsXml: string): Set<string> => {
  const document = slimdom.parseXmlDocument(relsXml);
  const ids = new Set<string>();
  for (const element of document.getElementsByTagNameNS("*", "Relationship")) {
    const id = element.getAttribute("Id");
    if (id !== null) {
      ids.add(id);
    }
  }
  return ids;
};

/** Find the next available rId in a relationships XML string */
export const findNextRId = (relsXml: string): string => {
  let max = 0n;
  for (const id of relationshipIds(relsXml)) {
    if (!/^rId\d+$/u.test(id)) {
      continue;
    }
    const n = BigInt(id.slice(3));
    if (n > max) {
      max = n;
    }
  }
  return `rId${max + 1n}`;
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
  if (relationshipIds(relsXml).has(rId)) {
    return relsXml;
  }
  const rel = `<Relationship Id="${escapedRId}" Type="${escapeXmlAttribute(type)}" Target="${escapeXmlAttribute(target)}"/>`;
  return relsXml.replace("</Relationships>", () => `${rel}\n</Relationships>`);
};
