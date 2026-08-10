/** Version of the public REST request and response contract. */
export const STELLA_REST_API_CONTRACT_VERSION = 1 as const;

export { SKILL_RESOURCE_PATH_PATTERN } from "./agent-skills";
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
export { CHAT_RUN_MODE, CHAT_TOOL_SCOPE, CHAT_TURN_INTENT } from "./chat";
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
export { ENTITY_KINDS, isEntityKind } from "./entity-kinds";
export type { EntityKind } from "./entity-kinds";
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
  MCP_WRITE_ONLY_RESOURCE_SCOPES,
} from "./mcp";
export type {
  McpAnonymizedResourceScope,
  McpDefaultResourceScope,
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
export { isSafeIdValue, toSafeId } from "./safe-id";
export type { SafeId } from "./safe-id";
export { CONTACT_TYPES, WORKSPACE_CONTACT_ROLES } from "./workspace-contacts";
export type { ContactType, WorkspaceContactRole } from "./workspace-contacts";
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
export const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox" as const;
export const MCP_APP_FRAME_TITLE_HASH_PARAM = "frame-title" as const;
export const MCP_APP_FRAME_TITLE_MAX_CHARS = 200;
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app" as const;
export const CHAT_RICH_PART_LIMITS = {
  identifierMaxChars: 512,
  inlineMediaMaxChars: 4 * 1024 * 1024,
  mediaMimeTypeMaxChars: 255,
  mediaUrlMaxChars: 2048,
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
