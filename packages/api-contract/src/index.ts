/** Version of the public REST request and response contract. */
export const STELLA_REST_API_CONTRACT_VERSION = 1 as const;

export { CHAT_RUN_MODE, CHAT_TOOL_SCOPE, CHAT_TURN_INTENT } from "./chat";
export type {
  ChatContinuation,
  ChatInterruptResolution,
  ChatRunMode,
  ChatSendRequest,
  SafeId,
} from "./chat";
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
  ENTITY_PRIORITIES,
  ENTITY_PRIORITY,
  isEntityPriority,
  isTaskStatus,
  TASK_STATUS,
  TASK_STATUSES,
} from "./entity-options";
export type { EntityPriority, TaskStatus } from "./entity-options";
export { API_VALIDATION_ERROR_CODE, normalizeApiError } from "./error";
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
export { FLOW_RUN_STATUSES, FLOW_RUN_STEP_STATUSES } from "./flow-status";
export type { FlowRunStatus, FlowRunStepStatus } from "./flow-status";
export {
  parseDesktopEditSessionRealtimeEvent,
  parseOrganizationRealtimeEvent,
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
} from "./realtime-events";
export type {
  DesktopEditSessionClientEvent,
  DesktopEditSessionRealtimeEvent,
  OrganizationRealtimeEvent,
  WorkspaceRealtimeEvent,
} from "./realtime-events";

/** Path prefix shared by the REST router and direct-fetch clients. */
export const STELLA_API_VERSION_PREFIX = "/v1" as const;
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
