export const DEFAULT_STELLA_DESKTOP_BRIDGE_PORT = 45_901;
export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type SessionStatus =
  | "opening"
  | "ready"
  | "syncing"
  | "finalizing"
  | "error";

export type SessionSnapshot = {
  baseVersionNumber: number;
  entityId: string;
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

export type OpenDocxRemoteSession = {
  baseVersionNumber: number;
  downloadUrl: string;
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

export type AppSnapshot = {
  bridgePort: number;
  /**
   * Monotonic integer the web app uses to feature-detect the bridge
   * protocol. Increment on every backwards-compatible change to the
   * bridge surface. Web code gates on `bridgeVersion >= N` instead
   * of coupling to the desktop's literal app version, so a web
   * release can ship that requires a minimum bridge without
   * waiting for every user's auto-update to land.
   */
  bridgeVersion: number;
  /**
   * Feature flags the desktop advertises. Strictly additive — once
   * a string ships, it stays forever, otherwise older web builds
   * that depend on it would silently degrade.
   */
  capabilities: string[];
  linkedAccount: LinkedAccountSnapshot | null;
  notificationPreferences: DesktopNotificationPreferences;
  runningSince: string;
  sessions: SessionSnapshot[];
  update: DesktopUpdateSnapshot;
};

export type OpenDocxRequest = {
  apiBaseUrl: string;
  entityId: string;
  linkedAccount: LinkedAccountSnapshot | null;
  propertyId: string;
  remoteSession: OpenDocxRemoteSession;
  workspaceId: string;
};

export type OpenDocxResponse = {
  alreadyOpen: boolean;
  filePath: string;
  sessionId: string;
};

export const isAppSnapshot = (value: unknown): value is AppSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const record = value as Record<string, unknown>;

  return (
    typeof record["bridgePort"] === "number" &&
    typeof record["bridgeVersion"] === "number" &&
    Array.isArray(record["capabilities"]) &&
    (record["capabilities"] as unknown[]).every((c) => typeof c === "string") &&
    typeof record["runningSince"] === "string" &&
    Array.isArray(record["sessions"]) &&
    typeof record["notificationPreferences"] === "object" &&
    record["notificationPreferences"] !== null &&
    typeof record["update"] === "object" &&
    record["update"] !== null
  );
};
