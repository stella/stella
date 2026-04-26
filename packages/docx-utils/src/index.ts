export { OOXML_NS, type OoxmlPrefix } from "./namespaces";
export {
  DOCX_COMPRESSION,
  loadDocx,
  extractText,
  extractBinary,
  repackZip,
} from "./zip";
export {
  findNextRId,
  ensureContentType,
  ensureRelationship,
} from "./relationships";
