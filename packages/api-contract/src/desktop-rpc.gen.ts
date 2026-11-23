// Generated from apps/desktop/src-tauri/src/types.rs.
// Regenerate from the repository root with `bun --filter @stll/desktop rpc:generate`.
// Do not edit by hand.

export type AppSnapshot = { documentRecovery: DocumentRecoverySnapshot, bridgePort: number,
/**
 * See [`BRIDGE_VERSION`].
 */
bridgeVersion: number,
/**
 * See [`BRIDGE_CAPABILITIES`].
 */
capabilities: string[], notificationPreferences: DesktopNotificationPreferences, runningSince: string, sessions: SessionSnapshot[], trustedSelfHostConnections: TrustedSelfHostConnection[], update: DesktopUpdateSnapshot, };

export type DesktopAccountCredential = { key: string, expiresAt: string, };

export type DesktopAccountIdentity = { userId: string, organizationId: string, };

export type DesktopAccountSnapshot = { "status": "disconnected", server: string, } | { "status": "reconnectRequired", server: string, } | { "status": "expired", server: string, } | { "status": "connected", account: LinkedAccountSnapshot, identity: DesktopAccountIdentity, expiresAt: string, server: string, avatar: string | null, };

export type DesktopEditFileType = "docx" | "xlsx" | "pptx";

export type DesktopLinkFailure = "account_conflict" | "switch_declined" | "declined" | "update_required" | "unavailable";

export type DesktopNotificationPreferences = { documentReady: boolean, revisionCreated: boolean, syncIssues: boolean, };

export type DesktopUpdateSnapshot = { currentVersion: string | null, };

export type DocumentRecoverySnapshot = { edits: RecoveryEdit[], unassigned: boolean, pending: boolean, access: RecoveryAccess, };

export type LinkAccountRequest = { apiBaseUrl: string, credential: DesktopAccountCredential, };

export type LinkedAccountSnapshot = { email: string, name: string | null, verifiedAt: string, };

export type OpenFileRemoteSession = { baseVersionNumber: number, downloadUrl: string, fileType: DesktopEditFileType, fileName: string, lastCheckpointAt: string | null, resumedFromCheckpoint: boolean, sessionId: string, sessionToken: string, tookOverExistingSession: boolean, };

export type OpenFileRequest = { apiBaseUrl: string, entityId: string, handoffId?: string | null, linkedAccount: LinkedAccountSnapshot | null, propertyId: string, remoteSession: OpenFileRemoteSession, workspaceId: string, };

export type OpenFileResponse = { alreadyOpen: boolean, filePath: string, sessionId: string, };

export type RecoveryAccess = "available" | "signInRequired";

export type RecoveryEdit = { id: string, fileName: string, status: RecoveryStatus, };

export type RecoveryStatus = "pending" | "available";

export type RecoveryTarget = "account" | "unassigned";

export type SessionSnapshot = { baseVersionNumber: number, entityId: string, fileType: DesktopEditFileType, fileName: string, filePath: string, id: string, lastError: string | null, lastCheckpointAt: string | null, pendingFinalize: boolean, propertyId: string, status: SessionStatus, takeoverDetected: boolean, workspaceId: string, };

export type SessionStatus = "opening" | "ready" | "syncing" | "finalizing" | "error";

export type TrustedSelfHostConnection = { apiBaseUrl: string, trustedAt: string, webOrigin: string, };

export type UpdaterSnapshot = { revision: number, state: UpdaterState, };

export type UpdaterState = { "status": "idle" } | { "status": "checking" } | { "status": "up_to_date" } | { "status": "available", version: string, } | { "status": "downloading", version: string, receivedBytes: number, totalBytes: number | null, } | { "status": "installing", version: string, } | { "status": "deferred", version: string, } | { "status": "failed", during: UpdaterStep, } | { "status": "managed" };

export type UpdaterStep = "check" | "install";
