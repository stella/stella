export const STELLA_DESKTOP_BRIDGE_PORT = 45_901;
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

type EmptyRecord = Record<string, never>;

type RequestSchema<TParams, TResponse> = {
  params: TParams;
  response: TResponse;
};

export type DesktopRPC = {
  bun: {
    requests: {
      openEditRoot: RequestSchema<EmptyRecord, boolean>;
      getState: RequestSchema<EmptyRecord, AppSnapshot>;
      updateNotificationPreferences: RequestSchema<
        {
          notificationPreferences: DesktopNotificationPreferences;
        },
        AppSnapshot
      >;
      checkForUpdates: RequestSchema<EmptyRecord, AppSnapshot>;
      downloadUpdate: RequestSchema<EmptyRecord, AppSnapshot>;
      applyUpdate: RequestSchema<EmptyRecord, AppSnapshot>;
      copyDiagnostics: RequestSchema<EmptyRecord, boolean>;
      emailSupport: RequestSchema<EmptyRecord, boolean>;
      revealSupportRoot: RequestSchema<EmptyRecord, boolean>;
      openSessionFile: RequestSchema<{ sessionId: string }, boolean>;
      revealSession: RequestSchema<{ sessionId: string }, boolean>;
      finishSession: RequestSchema<{ sessionId: string }, boolean>;
      retrySession: RequestSchema<{ sessionId: string }, boolean>;
    };
    messages: EmptyRecord;
  };
  webview: {
    requests: EmptyRecord;
    messages: {
      activateTab: {
        tab: "general" | "notifications" | "about";
      };
    };
  };
};

type RequestClient<
  TRequests extends Record<string, RequestSchema<unknown, unknown>>,
> = {
  [TKey in keyof TRequests]: (
    params: TRequests[TKey]["params"],
  ) => Promise<TRequests[TKey]["response"]>;
};

export type DesktopRpcClient = {
  request: RequestClient<DesktopRPC["bun"]["requests"]>;
};
