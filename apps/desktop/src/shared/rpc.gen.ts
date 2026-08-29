// Generated from apps/desktop/src-tauri/src/types.rs.
// Regenerate from the repository root with `bun --filter @stll/desktop rpc:generate`.
// Do not edit by hand.

export type AppSnapshot = { bridgePort: number,
/**
 * See [`BRIDGE_VERSION`].
 */
bridgeVersion: number,
/**
 * See [`BRIDGE_CAPABILITIES`].
 */
capabilities: string[], linkedAccount: LinkedAccountSnapshot | null, notificationPreferences: DesktopNotificationPreferences, runningSince: string, sessions: SessionSnapshot[], trustedSelfHostConnections: TrustedSelfHostConnection[], update: DesktopUpdateSnapshot, };

export type DesktopEditFileType = "docx" | "xlsx" | "pptx";

export type DesktopNotificationPreferences = { documentReady: boolean, revisionCreated: boolean, syncIssues: boolean, };

export type DesktopUpdateSnapshot = { baseUrl: string | null, channel: string | null, currentHash: string | null, currentVersion: string | null, lastCheckedAt: string | null, latestHash: string | null, latestVersion: string | null, status: DesktopUpdateStatus, statusMessage: string, updateAvailable: boolean, updateReady: boolean, };

export type DesktopUpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "applying" | "up_to_date" | "error" | "disabled";

export type LinkedAccountSnapshot = { email: string, name: string | null, verifiedAt: string, };

export type OpenFileRemoteSession = { baseVersionNumber: number, downloadUrl: string, fileType: DesktopEditFileType, fileName: string, lastCheckpointAt: string | null, resumedFromCheckpoint: boolean, sessionId: string, sessionToken: string, tookOverExistingSession: boolean, };

export type OpenFileRequest = { apiBaseUrl: string, entityId: string, handoffId?: string | null, linkedAccount: LinkedAccountSnapshot | null, propertyId: string, remoteSession: OpenFileRemoteSession, workspaceId: string, };

export type OpenFileResponse = { alreadyOpen: boolean, filePath: string, sessionId: string, };

export type SessionSnapshot = { baseVersionNumber: number, entityId: string, fileType: DesktopEditFileType, fileName: string, filePath: string, id: string, lastError: string | null, lastCheckpointAt: string | null, pendingFinalize: boolean, propertyId: string, status: SessionStatus, takeoverDetected: boolean, workspaceId: string, };

export type SessionStatus = "opening" | "ready" | "syncing" | "finalizing" | "error";

export type TrustedSelfHostConnection = { apiBaseUrl: string, trustedAt: string, webOrigin: string, };
