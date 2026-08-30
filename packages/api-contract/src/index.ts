/** Version of the public REST request and response contract. */
export const STELLA_REST_API_CONTRACT_VERSION = 1 as const;

export { AGENDA_ITEM_KINDS, AGENDA_ITEM_SOURCES } from "./agenda";
export type { AgendaItemKind, AgendaItemSource } from "./agenda";

export { SKILL_RESOURCE_PATH_PATTERN } from "./agent-skills";
export { OUTLOOK_AI_INPUT_MAX_CHARS, truncateOutlookAIInput } from "./ai";
export { AI_ERROR_KINDS } from "./ai-errors";
export type { AIErrorKind } from "./ai-errors";
export {
  BILLING_STATUS,
  EXPENSE_CATEGORIES,
  INVOICE_STATUS,
  INVOICE_STATUSES,
  TIME_ENTRY_SOURCE,
  TIME_ENTRY_SOURCES,
  TIME_ENTRY_STATUSES,
} from "./billing";
export type {
  ExpenseCategory,
  InvoiceStatus,
  TimeEntrySource,
  TimeEntryStatus,
} from "./billing";
export {
  BUSINESS_REGISTRY_SLUGS,
  isBusinessRegistrySlug,
} from "./business-registries";
export type { BusinessRegistrySlug } from "./business-registries";
export {
  CHAT_RUN_MODE,
  CHAT_THREAD_PLACEHOLDER_TITLE,
  CHAT_TOOL_SCOPE,
  CHAT_TURN_INTENT,
} from "./chat";
export {
  BUILT_IN_CHAT_TOOL_POLICY_KINDS,
  CHAT_TOOL_POLICY_KIND,
  CHAT_TOOL_POLICY_REQUIRES_APPROVAL,
} from "./chat-tool-policy";
export type {
  ApprovalRequiredBuiltInChatToolName,
  BuiltInChatToolPolicyKindByName,
  ChatToolPolicyKind,
  NeedsApprovalPolicyKind,
} from "./chat-tool-policy";
export type {
  ChatContinuation,
  ChatInterruptResolution,
  ChatRunMode,
  ChatSendRequest,
} from "./chat";
export {
  CHAT_EDIT_APPLY_MODE,
  DEFAULT_CHAT_EDIT_APPLY_MODE,
  DEFAULT_DOCX_EDIT_REPRESENTATION,
  DOCX_EDIT_REPRESENTATION,
} from "./chat-edit";
export type { ChatEditApplyMode, DocxEditRepresentation } from "./chat-edit";
export {
  CHAT_MENTION_CATEGORIES,
  CHAT_MENTION_HREF_PREFIXES,
  CHAT_REFERENCE_CATEGORIES,
  CHAT_REFERENCE_HREF_PREFIXES,
  isChatMentionCategory,
  isChatReferenceCategory,
} from "./chat-references";
export type {
  ChatMentionCategory,
  ChatMentionHref,
  ChatMentionHrefPrefix,
  ChatMentionHrefPrefixMap,
  ChatReferenceCategory,
  ChatReferenceHrefPrefix,
} from "./chat-references";
export {
  CHAT_SOURCE_CITATION_HREF_PREFIX,
  parseCanonicalChatSourceCitationHref,
  parseChatSourceCitationHref,
  replaceCanonicalChatSourceCitationHrefs,
  toChatSourceCitationHref,
} from "./chat-source-citations";
export type {
  ChatSourceCitationHref,
  ChatSourceCitationTarget,
} from "./chat-source-citations";
export {
  CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_ISSUE_CODE,
  CONTACT_IMPORT_MAPPING_MAX_CHARS,
  CONTACT_IMPORT_MAX_COLUMNS,
  CONTACT_IMPORT_MAX_ROWS,
  CONTACT_IMPORT_SCHEMA_VERSION,
  CONTACT_IMPORT_TARGET_FIELDS,
  CONTACT_IMPORT_TAX_ID_SCHEMES,
  parseContactImportMapping,
} from "./contact-import";
export type {
  ContactImportColumnMapping,
  ContactImportField,
  ContactImportIssueCode,
  ContactImportMapping,
  ContactImportMappingParseResult,
  ContactImportTargetField,
  ContactImportTaxIdScheme,
} from "./contact-import";
export {
  AUTHORED_DOCUMENT_PROPERTY_KEYS,
  DOCUMENT_PROPERTIES_RESULT_SCHEMA,
  DOCUMENT_PROPERTIES_MAX_BYTES,
  DOCUMENT_PROPERTY_KEYS,
  DOCUMENT_PROPERTY_MIME_TYPES,
  documentContainerFormat,
  GENERATED_DOCUMENT_PROPERTY_KEYS,
  hasDocumentProperties,
  isAuthoredDocumentPropertyKey,
} from "./document-properties";
export type {
  AuthoredDocumentPropertyKey,
  DocumentContainerFormat,
  DocumentPropertiesResult,
  DocumentPropertiesStatus,
  DocumentProperty,
  DocumentPropertyKey,
  DocumentPropertyValue,
} from "./document-properties";
export { ENTITY_KINDS, isEntityKind } from "./entity-kinds";
export type { EntityKind } from "./entity-kinds";
export { DOCUMENT_UPLOAD_POLICY } from "./upload-policy";
export {
  FOLIO_COLLAB_REDIS_SCOPE,
  parseFolioCollabRoomName,
  toFolioCollabRoomName,
} from "./folio-collab";
export {
  OUTLOOK_HOST_VERSION_PATTERN,
  OUTLOOK_INGESTION_HOSTS,
  OUTLOOK_INGESTION_OUTCOMES,
  OUTLOOK_INGESTION_PLATFORMS,
  OUTLOOK_INGESTION_RETRY_STAGES,
  OUTLOOK_MAILBOX_REQUIREMENT_SET,
} from "./outlook-ingestion";
export type {
  OutlookIngestionDiagnostic,
  OutlookIngestionHost,
  OutlookIngestionOutcome,
  OutlookIngestionPlatform,
  OutlookIngestionRetryStage,
} from "./outlook-ingestion";
export {
  parseOutlookAIDraftResponse,
  parseOutlookAISummaryResponse,
  parseOutlookFinalizeResponse,
  parseOutlookPropertiesResponse,
  parseOutlookPropertyCreatedResponse,
  parseOutlookPresignResponse,
  parseOutlookReconcileResponse,
  parseOutlookWorkspacesResponse,
} from "./outlook-api";
export type {
  OutlookAIDraftResponse,
  OutlookAISummaryResponse,
  OutlookFinalizeResponse,
  OutlookPropertiesResponse,
  OutlookPropertyCreatedResponse,
  OutlookPresignResponse,
  OutlookReconcileResponse,
  OutlookWorkspacesResponse,
} from "./outlook-api";
export {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
  isDesktopEditFileType,
} from "./desktop-edit-file-types";
export type {
  DesktopEditFileType,
  DesktopEditMimeType,
} from "./desktop-edit-file-types";
export {
  EMAIL_CITATION_HREF_PREFIX,
  EMAIL_HEADER_CITATION_ID,
  isEmailCitationBlockId,
  parseEmailCitationHref,
} from "./email-citations";
export type {
  EmailCitationHrefTarget,
  EmailHeaderCitationId,
} from "./email-citations";
export {
  isOfficeCitationBlockId,
  OFFICE_CITATION_HREF_PREFIX,
  parseOfficeCitationHref,
} from "./office-citations";
export type {
  OfficeCitationHrefTarget,
  OfficeCitationLocator,
} from "./office-citations";
export {
  ENTITY_PRIORITIES,
  ENTITY_PRIORITY,
  isEntityPriority,
  isTaskStatus,
  TASK_STATUS,
  TASK_STATUSES,
} from "./entity-options";
export type { EntityPriority, TaskStatus } from "./entity-options";
export {
  API_VALIDATION_ERROR_CODE,
  API_VERSION_CONFLICT_ERROR_CODE,
  normalizeApiError,
  parseApiErrorValue,
} from "./error";
export type {
  ApiErrorInput,
  ApiErrorObjectValue,
  ApiErrorValue,
  ApiValidationErrorValue,
  NormalizedApiError,
} from "./error";
export {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "./document-version-upload";
export type {
  DocumentVersionUploadFileMetadata,
  DocumentVersionUploadReservationInput,
  UploadLifecycleInput,
} from "./document-version-upload";
export {
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_RUN_TERMINAL_STATUSES,
  FLOW_SCHEDULE_FREQUENCIES,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_TYPES,
  isTerminalFlowRunStatus,
} from "./flow-status";
export type {
  FlowRunStatus,
  FlowRunStepStatus,
  FlowScheduleFrequency,
  FlowStepKind,
  FlowTriggerType,
  TerminalFlowRunStatus,
} from "./flow-status";
export {
  AGENT_SKILLS_CHAT_METADATA_MAX,
  CASE_LAW_CITATION_TIMELINE_MAX_YEARS,
  DOCX_SUGGESTIONS_PAGE_SIZE_MAX,
  ENTITIES_PER_WORKSPACE_MAX,
  FLOW_RUN_INPUT_ENTITIES_MAX,
  PROPERTIES_PER_WORKSPACE_MAX,
  PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX,
  VIEW_FILTERS_MAX,
  VIEW_SORTS_MAX,
  WORKSPACES_PER_ORGANIZATION_MAX,
} from "./limits";
export { GLOBAL_SEARCH_RESULT_TYPES } from "./search";
export type { GlobalSearchResultType } from "./search";
export {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
  matchesMatterReferencePattern,
  MATTER_REFERENCE_TOKENS,
  renderMatterReferencePattern,
} from "./matter-reference";
export type { MatterReferenceToken } from "./matter-reference";
export {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_OAUTH_PROTOCOL_SCOPES,
  MCP_WRITE_ONLY_RESOURCE_SCOPES,
} from "./mcp";
export type {
  McpAnonymizedResourceScope,
  McpDefaultResourceScope,
  McpOAuthScope,
  McpWriteOnlyResourceScope,
} from "./mcp";
export { OCR_EXPORT_STATUSES } from "./ocr-export";
export type { OcrExportStatus } from "./ocr-export";
export {
  MAX_RESOURCE_CHANGES_PER_EVENT,
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  RESOURCE_CHANGE_TYPE,
  resourceDeletedChange,
  resourceDeletedRealtimeEvent,
  resourceSetUpdatedRealtimeEvent,
  resourceUpdatedChange,
  resourceUpdatedRealtimeEvent,
  resourcesChangedRealtimeEvent,
} from "./realtime-events";
export { encodeRfc3986Component } from "./rfc3986";
export {
  SAVED_SEARCH_CRITERIA_VERSION,
  SAVED_SEARCH_SORTS,
} from "./saved-search";
export type {
  SavedSearchCriteria,
  SavedSearchSort,
  SavedSearchTimeFilter,
} from "./saved-search";
export type { TemplateRecipeDefinition } from "./template-recipe";
// `toSafeId` is deliberately absent from this barrel: it stamps the SafeId
// brand without any ownership check, so it stays behind the explicit
// '@stll/api-contract/safe-id' entry point that each app re-exports once.
export { isSafeIdValue } from "./safe-id";
export type { SafeId, SafeIdType } from "./safe-id";
export { CONTACT_TYPES, WORKSPACE_CONTACT_ROLES } from "./workspace-contacts";
export type { ContactType, WorkspaceContactRole } from "./workspace-contacts";
export {
  CONTACT_IMPORT_LABELED_FIELDS,
  CONTACT_IMPORT_VOCABULARIES,
} from "./contact-import-labeled";
export type {
  ContactImportLabeledField,
  ContactImportVocabularyId,
} from "./contact-import-labeled";
export {
  DIRECTLY_CREATABLE_VIEW_LAYOUTS,
  isRequiredViewLayout,
  REQUIRED_VIEW_LAYOUTS,
  VIEW_LAYOUT_TYPES,
} from "./view-layout";
export type {
  DirectlyCreatableViewLayoutType,
  RequiredViewLayoutType,
  ViewLayoutType,
} from "./view-layout";
export type {
  DesktopEditSessionClientEvent,
  DesktopEditSessionRealtimeEvent,
  OrganizationRealtimeEvent,
  ResourceChange,
  ResourceRealtimeEvent,
  WorkspaceRealtimeEvent,
} from "./realtime-events";
export {
  isResourceRef,
  isResourceType,
  parseResourceName,
  parseResourceRef,
  resourceRef,
  RESOURCE_ID_TYPE,
  RESOURCE_NAME_PREFIX,
  RESOURCE_TYPE,
  toResourceName,
} from "./resource-ref";
export type { ResourceName, ResourceRef, ResourceType } from "./resource-ref";
export {
  CHAT_RESOURCE_HREF_PREFIX,
  CHAT_RESOURCE_LINK_DISPOSITION,
  findCanonicalChatResourceHrefs,
  parseCanonicalChatResourceHref,
  parseChatResourceHref,
  replaceCanonicalChatResourceHrefs,
  toChatMentionResourceHref,
  toChatResourceHref,
} from "./resource-link";
export type {
  CanonicalChatResourceHrefMatch,
  ChatResourceHref,
  ChatResourceLinkTarget,
  ChatMentionResourceHref,
  ChatMentionResourceLinkTarget,
} from "./resource-link";

/** Path prefix shared by the REST router and direct-fetch clients. */
export const STELLA_API_VERSION_PREFIX = "/v1" as const;
export const MAX_EMAIL_TEXT_ATTACHMENT_PREVIEW_BYTES = 1024 * 1024;
export const EMAIL_TEXT_ATTACHMENT_CHARSET = {
  big5: "big5",
  eucJp: "euc-jp",
  eucKr: "euc-kr",
  gb18030: "gb18030",
  gbk: "gbk",
  ibm866: "ibm866",
  iso2022Jp: "iso-2022-jp",
  iso885910: "iso-8859-10",
  iso885913: "iso-8859-13",
  iso885914: "iso-8859-14",
  iso885915: "iso-8859-15",
  iso885916: "iso-8859-16",
  iso88592: "iso-8859-2",
  iso88593: "iso-8859-3",
  iso88594: "iso-8859-4",
  iso88595: "iso-8859-5",
  iso88596: "iso-8859-6",
  iso88597: "iso-8859-7",
  iso88598: "iso-8859-8",
  koi8R: "koi8-r",
  koi8U: "koi8-u",
  macintosh: "macintosh",
  shiftJis: "shift_jis",
  utf8: "utf-8",
  utf16: "utf-16",
  utf16Be: "utf-16be",
  utf16Le: "utf-16le",
  windows874: "windows-874",
  windows1250: "windows-1250",
  windows1251: "windows-1251",
  windows1252: "windows-1252",
  windows1253: "windows-1253",
  windows1254: "windows-1254",
  windows1255: "windows-1255",
  windows1256: "windows-1256",
  windows1257: "windows-1257",
  windows1258: "windows-1258",
  xMacCyrillic: "x-mac-cyrillic",
  xUserDefined: "x-user-defined",
} as const;
export type EmailTextAttachmentCharset =
  (typeof EMAIL_TEXT_ATTACHMENT_CHARSET)[keyof typeof EMAIL_TEXT_ATTACHMENT_CHARSET];

/**
 * Bounded WHATWG Encoding labels accepted for passive email text previews.
 * Keeping labels in the API contract means the server cannot send a decoder
 * name that the client has not explicitly accepted and rendered safely.
 */
export const EMAIL_TEXT_ATTACHMENT_CHARSET_LABELS = {
  [EMAIL_TEXT_ATTACHMENT_CHARSET.big5]: [
    "big5",
    "big5-hkscs",
    "cn-big5",
    "csbig5",
    "x-x-big5",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.eucJp]: [
    "cseucpkdfmtjapanese",
    "euc-jp",
    "x-euc-jp",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.eucKr]: [
    "cseuckr",
    "csksc56011987",
    "euc-kr",
    "iso-ir-149",
    "korean",
    "ks_c_5601-1987",
    "ks_c_5601-1989",
    "ksc5601",
    "ksc_5601",
    "windows-949",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.gb18030]: ["gb18030"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.gbk]: [
    "chinese",
    "csgb2312",
    "csiso58gb231280",
    "gb2312",
    "gb_2312",
    "gb_2312-80",
    "gbk",
    "iso-ir-58",
    "x-gbk",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.ibm866]: [
    "866",
    "cp866",
    "csibm866",
    "ibm866",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso2022Jp]: ["csiso2022jp", "iso-2022-jp"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88592]: [
    "csisolatin2",
    "iso-8859-2",
    "iso-ir-101",
    "iso8859-2",
    "iso88592",
    "iso_8859-2",
    "iso_8859-2:1987",
    "l2",
    "latin2",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88593]: [
    "csisolatin3",
    "iso-8859-3",
    "iso-ir-109",
    "iso8859-3",
    "iso88593",
    "iso_8859-3",
    "iso_8859-3:1988",
    "l3",
    "latin3",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88594]: [
    "csisolatin4",
    "iso-8859-4",
    "iso-ir-110",
    "iso8859-4",
    "iso88594",
    "iso_8859-4",
    "iso_8859-4:1988",
    "l4",
    "latin4",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88595]: [
    "csisolatincyrillic",
    "cyrillic",
    "iso-8859-5",
    "iso-ir-144",
    "iso8859-5",
    "iso88595",
    "iso_8859-5",
    "iso_8859-5:1988",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88596]: [
    "arabic",
    "asmo-708",
    "csiso88596e",
    "csiso88596i",
    "csisolatinarabic",
    "ecma-114",
    "iso-8859-6",
    "iso-8859-6-e",
    "iso-8859-6-i",
    "iso-ir-127",
    "iso8859-6",
    "iso88596",
    "iso_8859-6",
    "iso_8859-6:1987",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88597]: [
    "csisolatingreek",
    "ecma-118",
    "elot_928",
    "greek",
    "greek8",
    "iso-8859-7",
    "iso-ir-126",
    "iso8859-7",
    "iso88597",
    "iso_8859-7",
    "iso_8859-7:1987",
    "sun_eu_greek",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso88598]: [
    "csiso88598e",
    "csiso88598i",
    "csisolatinhebrew",
    "hebrew",
    "iso-8859-8",
    "iso-8859-8-e",
    "iso-8859-8-i",
    "iso-ir-138",
    "iso8859-8",
    "iso88598",
    "iso_8859-8",
    "iso_8859-8:1988",
    "logical",
    "visual",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso885910]: [
    "csisolatin6",
    "iso-8859-10",
    "iso-ir-157",
    "iso8859-10",
    "iso885910",
    "l6",
    "latin6",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso885913]: [
    "iso-8859-13",
    "iso8859-13",
    "iso885913",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso885914]: [
    "iso-8859-14",
    "iso8859-14",
    "iso885914",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso885915]: [
    "csisolatin9",
    "iso-8859-15",
    "iso8859-15",
    "iso885915",
    "iso_8859-15",
    "l9",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.iso885916]: ["iso-8859-16"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.koi8R]: [
    "cskoi8r",
    "koi",
    "koi8",
    "koi8-r",
    "koi8_r",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.koi8U]: ["koi8-ru", "koi8-u"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.macintosh]: [
    "csmacintosh",
    "mac",
    "macintosh",
    "x-mac-roman",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.shiftJis]: [
    "csshiftjis",
    "ms932",
    "ms_kanji",
    "shift-jis",
    "shift_jis",
    "sjis",
    "windows-31j",
    "x-sjis",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.utf8]: [
    "unicode-1-1-utf-8",
    "unicode11utf8",
    "unicode20utf8",
    "utf-8",
    // eslint-disable-next-line unicorn/text-encoding-identifier-case -- exact WHATWG legacy label
    "utf8",
    "x-unicode20utf8",
  ],
  // Keep generic UTF-16 distinct from UTF-16LE: its BOM determines byte order.
  [EMAIL_TEXT_ATTACHMENT_CHARSET.utf16]: ["utf-16"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Be]: ["unicodefffe", "utf-16be"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.utf16Le]: [
    "csunicode",
    "iso-10646-ucs-2",
    "ucs-2",
    "unicode",
    "unicodefeff",
    "utf-16le",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows874]: [
    "dos-874",
    "iso-8859-11",
    "iso8859-11",
    "iso885911",
    "tis-620",
    "windows-874",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1250]: [
    "cp1250",
    "windows-1250",
    "x-cp1250",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1251]: [
    "cp1251",
    "windows-1251",
    "x-cp1251",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1252]: [
    "ansi_x3.4-1968",
    "ascii",
    "cp1252",
    "cp819",
    "csisolatin1",
    "ibm819",
    "iso-8859-1",
    "iso-ir-100",
    "iso8859-1",
    "iso88591",
    "iso_8859-1",
    "iso_8859-1:1987",
    "l1",
    "latin1",
    "us-ascii",
    "windows-1252",
    "x-cp1252",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1253]: [
    "cp1253",
    "windows-1253",
    "x-cp1253",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1254]: [
    "cp1254",
    "csisolatin5",
    "iso-8859-9",
    "iso-ir-148",
    "iso8859-9",
    "iso88599",
    "iso_8859-9",
    "iso_8859-9:1989",
    "l5",
    "latin5",
    "windows-1254",
    "x-cp1254",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1255]: [
    "cp1255",
    "windows-1255",
    "x-cp1255",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1256]: [
    "cp1256",
    "windows-1256",
    "x-cp1256",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1257]: [
    "cp1257",
    "windows-1257",
    "x-cp1257",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.windows1258]: [
    "cp1258",
    "windows-1258",
    "x-cp1258",
  ],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.xMacCyrillic]: ["x-mac-cyrillic"],
  [EMAIL_TEXT_ATTACHMENT_CHARSET.xUserDefined]: ["x-user-defined"],
} as const satisfies Record<EmailTextAttachmentCharset, readonly string[]>;
export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox" as const;
export const MCP_APP_FRAME_TITLE_HASH_PARAM = "frame-title" as const;
export const MCP_APP_FRAME_TITLE_MAX_CHARS = 200;
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app" as const;
export const DOCUMENT_REVIEW_LIMITS = {
  referencesMax: 3,
  topicsMax: 200,
} as const;
/**
 * Where a playbook run's results land. Shared so the request body's accepted
 * values and the control that sends them are one declaration.
 *
 * `columns` materializes the playbook's extraction and verdict columns onto the
 * matter's table, at two columns per graded position. `none` materializes none:
 * the same review runs per document and its findings are read through the
 * review surface. Named rather than a boolean, because the next answer
 * ("project only these positions") is a third projection, not a negation.
 */
export const PLAYBOOK_RUN_PROJECTIONS = ["columns", "none"] as const;
export type PlaybookRunProjection = (typeof PLAYBOOK_RUN_PROJECTIONS)[number];
export const CHAT_RICH_PART_LIMITS = {
  identifierMaxChars: 512,
  inlineMediaMaxChars: 4 * 1024 * 1024,
  mediaMimeTypeMaxChars: 255,
  mediaUrlMaxChars: 2048,
  mentionsMax: 100,
  uiResourceContentMaxChars: 1024 * 1024,
  uiResourceUriMaxChars: 2048,
} as const;

const BASE64_CONTENT_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export const isBoundedBase64Content = (
  value: string,
  maxChars: number,
): boolean => {
  if (
    value.length === 0 ||
    value.length > maxChars ||
    !BASE64_CONTENT_PATTERN.test(value)
  ) {
    return false;
  }
  const paddingLength = value.endsWith("==") ? 2 : Number(value.endsWith("="));
  return (
    (paddingLength === 0 || value.length % 4 === 0) &&
    (value.length - paddingLength) % 4 !== 1
  );
};

export const buildVersionedApiUrl = (
  origin: string,
  path: `/${string}`,
): string =>
  `${origin.endsWith("/") ? origin.slice(0, -1) : origin}${STELLA_API_VERSION_PREFIX}${path}`;
