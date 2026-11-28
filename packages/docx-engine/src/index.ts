export {
  ATTORNEY_REFS,
  CONTACT_FIELDS,
  fieldSourceSchema,
  FIRM_FIELDS,
  MATTER_FIELDS,
  USER_FIELDS,
  WORKSPACE_CONTACT_ROLES,
} from "./binding-sources";
export type {
  AttorneyRef,
  ContactField,
  FieldSource,
  FirmField,
  MatterField,
  UserField,
  WorkspaceContactRole,
} from "./binding-sources";
export {
  collectClauseSlots,
  discoverClauseSlotsFromBytes,
} from "./clause-slots";
export type { ClauseSlot } from "./clause-slots";
export { diffParagraphs } from "./diff-paragraphs";
export { discoverPlaceholders } from "./discover-placeholders";
export { paragraphText, templateContentPartPaths, W_NS } from "./ooxml";
export { stripManifest } from "./strip-custom-xml-manifest";
