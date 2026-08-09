import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@stll/api-contract";
import type { DesktopEditFileType } from "@stll/api-contract";

export const DEFAULT_STELLA_DESKTOP_BRIDGE_PORT = 45_901;
export const DOCX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType;
export const XLSX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType;
export const PPTX_MIME_TYPE = DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.mimeType;
export { DESKTOP_EDIT_FILE_TYPE_CONFIG as DESKTOP_EDIT_FILE_TYPES };
export type { DesktopEditFileType } from "@stll/api-contract";

export type SessionStatus =
  | "opening"
  | "ready"
  | "syncing"
  | "finalizing"
  | "error";

export type SessionSnapshot = {
  baseVersionNumber: number;
  entityId: string;
  fileType: DesktopEditFileType;
  fileName: string;
  filePath: string;
  id: string;
  lastError: string | null;
  lastCheckpointAt: string | null;
  pendingFinalize: boolean;
  propertyId: string;
  status: SessionStatus;
  takeoverDetected: boolean;
  workspaceId: string;
};

export type DesktopNotificationPreferences = {
  documentReady: boolean;
  revisionCreated: boolean;
  syncIssues: boolean;
};

export type LinkedAccountSnapshot = {
  email: string;
  name: string | null;
  verifiedAt: string;
};

export type OpenFileRemoteSession = {
  baseVersionNumber: number;
  downloadUrl: string;
  fileType: DesktopEditFileType;
  fileName: string;
  lastCheckpointAt: string | null;
  resumedFromCheckpoint: boolean;
  sessionId: string;
  sessionToken: string;
  tookOverExistingSession: boolean;
};

export type DesktopUpdateSnapshot = {
  baseUrl: string | null;
  channel: string | null;
  currentHash: string | null;
  currentVersion: string | null;
  lastCheckedAt: string | null;
  latestHash: string | null;
  latestVersion: string | null;
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "applying"
    | "up_to_date"
    | "error"
    | "disabled";
  statusMessage: string;
  updateAvailable: boolean;
  updateReady: boolean;
};

export type TrustedSelfHostConnection = {
  apiBaseUrl: string;
  trustedAt: string;
  webOrigin: string;
};

export type AppSnapshot = {
  bridgePort: number;
  /**
   * Monotonic bridge contract revision. Web code gates on a minimum
   * revision and required capability instead of coupling to the
   * desktop's literal app version.
   */
  bridgeVersion: number;
  /**
   * Versioned contracts advertised by the desktop. Breaking semantics
   * receive a new capability id.
   */
  capabilities: string[];
  linkedAccount: LinkedAccountSnapshot | null;
  notificationPreferences: DesktopNotificationPreferences;
  runningSince: string;
  sessions: SessionSnapshot[];
  trustedSelfHostConnections: TrustedSelfHostConnection[];
  update: DesktopUpdateSnapshot;
};

export type OpenFileRequest = {
  apiBaseUrl: string;
  entityId: string;
  linkedAccount: LinkedAccountSnapshot | null;
  propertyId: string;
  remoteSession: OpenFileRemoteSession;
  workspaceId: string;
};

export type OpenFileResponse = {
  alreadyOpen: boolean;
  filePath: string;
  sessionId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isFileType = (value: unknown): value is DesktopEditFileType =>
  value === "docx" || value === "xlsx" || value === "pptx";

export const isAppSnapshot = (value: unknown): value is AppSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["bridgePort"] === "number" &&
    typeof value["bridgeVersion"] === "number" &&
    isStringArray(value["capabilities"]) &&
    typeof value["runningSince"] === "string" &&
    Array.isArray(value["sessions"]) &&
    value["sessions"].every(
      (session) => isRecord(session) && isFileType(session["fileType"]),
    ) &&
    Array.isArray(value["trustedSelfHostConnections"]) &&
    isRecord(value["notificationPreferences"]) &&
    isRecord(value["update"])
  );
};
