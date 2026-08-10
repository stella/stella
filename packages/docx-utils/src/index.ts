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
