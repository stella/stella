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
  removedRelationshipIds: readonly string[];
  sourcePartPath: string | null;
  xml: string;
};

type SanitizedAttachedTemplateSource = {
  removed: number;
  xml: string;
};

const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const ATTACHED_TEMPLATE_RELATIONSHIP_TYPES = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate",
] as const;
const WORDPROCESSINGML_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
] as const;
const OFFICE_RELATIONSHIPS_NAMESPACES = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
] as const;
const RELATIONSHIPS_SUFFIX = ".rels";
const RELATIONSHIPS_DIRECTORY = "_rels";
const ROOT_RELATIONSHIPS_PATH = "_rels/.rels";
const WINDOWS_DRIVE_PATH_RE = /^[a-z]:[\\/]/iu;
const UNC_PATH_RE = /^(?:\\\\|\/\/)[^\\/]/u;

const isAttachedTemplateRelationship = (element: slimdom.Element): boolean => {
  if (
    element.localName !== "Relationship" ||
    element.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE
  ) {
    return false;
  }
  const type = element.getAttribute("Type")?.trim();
  return ATTACHED_TEMPLATE_RELATIONSHIP_TYPES.some(
    (attachedTemplateType) => attachedTemplateType === type,
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
  if (
    relationshipsPartPath.includes("\\") ||
    relationshipsPartPath.startsWith("/")
  ) {
    return null;
  }
  if (relationshipsPartPath === ROOT_RELATIONSHIPS_PATH) {
    return null;
  }
  const segments = relationshipsPartPath.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  const relationshipDirectory = segments.at(-2);
  const relationshipFileName = segments.at(-1);
  if (
    relationshipDirectory !== RELATIONSHIPS_DIRECTORY ||
    relationshipFileName === undefined ||
    !relationshipFileName.endsWith(RELATIONSHIPS_SUFFIX)
  ) {
    return null;
  }
  const sourceFileName = relationshipFileName.slice(
    0,
    -RELATIONSHIPS_SUFFIX.length,
  );
  if (sourceFileName === "") {
    return null;
  }
  const sourceDirectory = segments.slice(0, -2);
  return [...sourceDirectory, sourceFileName].join("/");
};

export const isOpcRelationshipPartPath = (path: string): boolean =>
  path === ROOT_RELATIONSHIPS_PATH || relationshipSourcePartPath(path) !== null;

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
      removedRelationshipIds: [],
      sourcePartPath: relationshipSourcePartPath(relationshipsPartPath),
      xml,
    };
  }

  const findings = relationships.map((relationship) => ({
    rule: ATTACHED_TEMPLATE_SECURITY_RULE,
    targetKind: classifyAttachedTemplateTarget(
      relationship.getAttribute("Target"),
    ),
  }));
  const removedRelationshipIds = relationships.flatMap((relationship) => {
    const id = relationship.getAttribute("Id")?.trim();
    return id ? [id] : [];
  });
  for (const relationship of relationships) {
    relationship.remove();
  }

  return {
    findings,
    removedRelationshipIds,
    sourcePartPath: relationshipSourcePartPath(relationshipsPartPath),
    xml: slimdom.serializeToWellFormedString(document),
  };
};

const relationshipReferenceId = (element: slimdom.Element): string | null => {
  for (const namespace of OFFICE_RELATIONSHIPS_NAMESPACES) {
    const id = element.getAttributeNS(namespace, "id");
    if (id !== null) {
      return id;
    }
  }
  return null;
};

/** Remove WordprocessingML references to the relationships removed above. */
export const sanitizeAttachedTemplateSource = (
  xml: string,
  removedRelationshipIds: readonly string[],
): SanitizedAttachedTemplateSource => {
  if (removedRelationshipIds.length === 0) {
    return { removed: 0, xml };
  }
  const document = slimdom.parseXmlDocument(xml);
  const root = document.documentElement;
  if (
    root === null ||
    root.localName !== "settings" ||
    !WORDPROCESSINGML_NAMESPACES.some(
      (namespace) => namespace === root.namespaceURI,
    )
  ) {
    return { removed: 0, xml };
  }
  const relationshipIds = new Set(removedRelationshipIds);
  const references = descendantElements(document).filter(
    (element) =>
      element.localName === "attachedTemplate" &&
      element.namespaceURI === root.namespaceURI &&
      relationshipIds.has(relationshipReferenceId(element) ?? ""),
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
