/** Find the next available rId in a relationships XML string */
export const findNextRId = (relsXml: string): string => {
  const matches = relsXml.matchAll(/Id="rId(\d+)"/gu);
  let max = 0;
  for (const m of matches) {
    const n = Number.parseInt(m[1] ?? "0", 10);
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
  if (contentTypesXml.includes(`PartName="${partName}"`)) {
    return contentTypesXml;
  }
  const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  return contentTypesXml.replace("</Types>", `${override}\n</Types>`);
};

/** Ensure a relationship entry exists */
export const ensureRelationship = (
  relsXml: string,
  rId: string,
  type: string,
  target: string,
): string => {
  if (relsXml.includes(`Id="${rId}"`)) {
    return relsXml;
  }
  const rel = `<Relationship Id="${rId}" Type="${type}" Target="${target}"/>`;
  return relsXml.replace("</Relationships>", `${rel}\n</Relationships>`);
};
