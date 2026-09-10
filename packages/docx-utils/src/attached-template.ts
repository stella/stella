import * as slimdom from "slimdom";

export const ATTACHED_TEMPLATE_SECURITY_RULE =
  "ooxml_attached_template" as const;

export const ATTACHED_TEMPLATE_TARGET_KIND = {
  local: "local",
  network: "network",
  unknown: "unknown",
} as const;

export type AttachedTemplateTargetKind =
  (typeof ATTACHED_TEMPLATE_TARGET_KIND)[keyof typeof ATTACHED_TEMPLATE_TARGET_KIND];

export type AttachedTemplateRelationshipFinding = {
  rule: typeof ATTACHED_TEMPLATE_SECURITY_RULE;
  targetKind: AttachedTemplateTargetKind;
};

type SanitizedAttachedTemplateRelationships = {
  findings: readonly AttachedTemplateRelationshipFinding[];
  sourcePartPath: string | null;
  xml: string;
};

type SanitizedAttachedTemplateSource = {
  removed: number;
  xml: string;
};

const ATTACHED_TEMPLATE_RELATIONSHIP_TYPE = "/attachedtemplate";
const RELATIONSHIPS_SUFFIX = ".rels";
const ROOT_RELATIONSHIPS_PREFIX = "_rels/";
const NESTED_RELATIONSHIPS_SEGMENT = "/_rels/";
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/iu;
const UNC_PATH_RE = /^(?:\\\\|\/\/)[^\\/]/u;

const attributeByLocalName = (
  element: slimdom.Element,
  expectedName: string,
): string | null => {
  const expected = expectedName.toLowerCase();
  return (
    element.attributes.find(
      ({ localName }) => localName.toLowerCase() === expected,
    )?.value ?? null
  );
};

const isAttachedTemplateRelationship = (element: slimdom.Element): boolean => {
  if (element.localName.toLowerCase() !== "relationship") {
    return false;
  }
  const type = attributeByLocalName(element, "Type")?.trim().toLowerCase();
  return (
    type === "attachedtemplate" ||
    type?.endsWith(ATTACHED_TEMPLATE_RELATIONSHIP_TYPE) === true
  );
};

const descendantElements = (root: slimdom.Node): slimdom.Element[] => {
  const elements: slimdom.Element[] = [];
  const pending = [...root.childNodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (node instanceof slimdom.Element) {
      elements.push(node);
    }
    for (const child of node.childNodes) {
      pending.push(child);
    }
  }
  return elements;
};

/**
 * Classify where Word would resolve an attached template without retaining or
 * returning the target itself. Template targets can contain usernames, host
 * names, and internal paths, none of which belong in findings or telemetry.
 */
export const classifyAttachedTemplateTarget = (
  target: string | null,
): AttachedTemplateTargetKind => {
  const normalized = target?.trim();
  if (!normalized || normalized.includes("\0")) {
    return ATTACHED_TEMPLATE_TARGET_KIND.unknown;
  }
  if (UNC_PATH_RE.test(normalized)) {
    return ATTACHED_TEMPLATE_TARGET_KIND.network;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return ATTACHED_TEMPLATE_TARGET_KIND.local;
  }

  if (!URL.canParse(normalized)) {
    // OOXML permits relative relationship targets. They resolve within the
    // user's filesystem rather than over a URL scheme.
    return ATTACHED_TEMPLATE_TARGET_KIND.local;
  }
  const url = new URL(normalized);
  if (url.protocol !== "file:") {
    return ATTACHED_TEMPLATE_TARGET_KIND.network;
  }
  if (url.pathname.startsWith("//")) {
    return ATTACHED_TEMPLATE_TARGET_KIND.network;
  }
  return url.hostname === "" || url.hostname.toLowerCase() === "localhost"
    ? ATTACHED_TEMPLATE_TARGET_KIND.local
    : ATTACHED_TEMPLATE_TARGET_KIND.network;
};

/** Resolve `word/_rels/settings.xml.rels` to its owning `word/settings.xml`. */
export const relationshipSourcePartPath = (
  relationshipsPartPath: string,
): string | null => {
  if (!relationshipsPartPath.endsWith(RELATIONSHIPS_SUFFIX)) {
    return null;
  }
  if (relationshipsPartPath === `${ROOT_RELATIONSHIPS_PREFIX}.rels`) {
    return null;
  }
  if (relationshipsPartPath.startsWith(ROOT_RELATIONSHIPS_PREFIX)) {
    return relationshipsPartPath
      .slice(ROOT_RELATIONSHIPS_PREFIX.length)
      .slice(0, -RELATIONSHIPS_SUFFIX.length);
  }

  const segmentIndex = relationshipsPartPath.lastIndexOf(
    NESTED_RELATIONSHIPS_SEGMENT,
  );
  if (segmentIndex === -1) {
    return null;
  }
  const directory = relationshipsPartPath.slice(0, segmentIndex);
  const fileName = relationshipsPartPath
    .slice(segmentIndex + NESTED_RELATIONSHIPS_SEGMENT.length)
    .slice(0, -RELATIONSHIPS_SUFFIX.length);
  return fileName === "" ? null : `${directory}/${fileName}`;
};

/**
 * Find and remove every attached-template relationship in one `.rels` part.
 * Unchanged XML is returned byte-for-byte when no relationship is present.
 */
export const sanitizeAttachedTemplateRelationships = (
  xml: string,
  relationshipsPartPath: string,
): SanitizedAttachedTemplateRelationships => {
  const document = slimdom.parseXmlDocument(xml);
  const relationships = descendantElements(document).filter(
    isAttachedTemplateRelationship,
  );
  if (relationships.length === 0) {
    return {
      findings: [],
      sourcePartPath: relationshipSourcePartPath(relationshipsPartPath),
      xml,
    };
  }

  const findings = relationships.map((relationship) => ({
    rule: ATTACHED_TEMPLATE_SECURITY_RULE,
    targetKind: classifyAttachedTemplateTarget(
      attributeByLocalName(relationship, "Target"),
    ),
  }));
  for (const relationship of relationships) {
    relationship.remove();
  }

  return {
    findings,
    sourcePartPath: relationshipSourcePartPath(relationshipsPartPath),
    xml: slimdom.serializeToWellFormedString(document),
  };
};

/** Remove the WordprocessingML element that points at a removed relationship. */
export const sanitizeAttachedTemplateSource = (
  xml: string,
): SanitizedAttachedTemplateSource => {
  const document = slimdom.parseXmlDocument(xml);
  const references = descendantElements(document).filter(
    ({ localName }) => localName.toLowerCase() === "attachedtemplate",
  );
  if (references.length === 0) {
    return { removed: 0, xml };
  }
  for (const reference of references) {
    reference.remove();
  }
  return {
    removed: references.length,
    xml: slimdom.serializeToWellFormedString(document),
  };
};
