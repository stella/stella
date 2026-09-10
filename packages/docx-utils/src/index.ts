export { OOXML_NS, type OoxmlPrefix } from "./namespaces.ts";
export {
  DOCX_COMPRESSION,
  loadDocx,
  extractText,
  extractBinary,
  repackZip,
} from "./zip.ts";
export {
  findNextRId,
  ensureContentType,
  ensureRelationship,
} from "./relationships.ts";
export {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  ATTACHED_TEMPLATE_TARGET_KIND,
  classifyAttachedTemplateTarget,
  relationshipSourcePartPath,
  sanitizeAttachedTemplateRelationships,
  sanitizeAttachedTemplateSource,
  type AttachedTemplateRelationshipFinding,
  type AttachedTemplateTargetKind,
} from "./attached-template.ts";
