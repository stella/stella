import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  DesktopNotificationPreferences,
  LinkedAccountSnapshot,
  SessionStatus,
} from "../shared/rpc";

type SessionStoreLoadIssue = "invalid_store" | "unreadable_store";

type PersistedDesktopSession = {
  apiBaseUrl: string;
  baseVersionNumber: number;
  entityId: string;
  fileName: string;
  filePath: string;
  id: string;
  key: string;
  lastCheckpointAt: string | null;
  lastCheckpointSha: string | null;
  lastError: string | null;
  lastLocalSha: string;
  pendingFinalize: boolean;
  propertyId: string;
  sessionToken: string;
  status: SessionStatus;
  takeoverDetected: boolean;
  workspaceId: string;
};

type SessionStorePayload = {
  cleanupPaths?: string[];
  linkedAccount?: LinkedAccountSnapshot | null;
  notificationPreferences?: DesktopNotificationPreferences | null;
  sessions: PersistedDesktopSession[];
};

type LoadedSessionStore = SessionStorePayload & {
  loadIssue: SessionStoreLoadIssue | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNullableString = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

const isSessionStatus = (value: unknown): value is SessionStatus =>
  value === "opening" ||
  value === "ready" ||
  value === "syncing" ||
  value === "finalizing" ||
  value === "error";

const isDesktopNotificationPreferences = (
  value: unknown,
): value is DesktopNotificationPreferences =>
  isRecord(value) &&
  typeof value.documentReady === "boolean" &&
  typeof value.revisionCreated === "boolean" &&
  typeof value.syncIssues === "boolean";

const isLinkedAccountSnapshot = (
  value: unknown,
): value is LinkedAccountSnapshot =>
  isRecord(value) &&
  typeof value.email === "string" &&
  isNullableString(value.name) &&
  typeof value.verifiedAt === "string";

const isPersistedDesktopSession = (
  value: unknown,
): value is PersistedDesktopSession => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.apiBaseUrl === "string" &&
    typeof value.baseVersionNumber === "number" &&
    typeof value.entityId === "string" &&
    typeof value.fileName === "string" &&
    typeof value.filePath === "string" &&
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    isNullableString(value.lastCheckpointAt) &&
    isNullableString(value.lastCheckpointSha) &&
    isNullableString(value.lastError) &&
    typeof value.lastLocalSha === "string" &&
    typeof value.pendingFinalize === "boolean" &&
    typeof value.propertyId === "string" &&
    typeof value.sessionToken === "string" &&
    isSessionStatus(value.status) &&
    typeof value.takeoverDetected === "boolean" &&
    typeof value.workspaceId === "string"
  );
};

const isSessionStorePayload = (
  value: unknown,
): value is SessionStorePayload => {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return false;
  }

  const cleanupPathsValid =
    !("cleanupPaths" in value) ||
    (Array.isArray(value.cleanupPaths) &&
      value.cleanupPaths.every((entry) => typeof entry === "string"));
  const linkedAccountValid =
    !("linkedAccount" in value) ||
    value.linkedAccount === null ||
    isLinkedAccountSnapshot(value.linkedAccount);
  const notificationPreferencesValid =
    !("notificationPreferences" in value) ||
    value.notificationPreferences === null ||
    isDesktopNotificationPreferences(value.notificationPreferences);

  return (
    cleanupPathsValid &&
    linkedAccountValid &&
    notificationPreferencesValid &&
    value.sessions.every(isPersistedDesktopSession)
  );
};

export const loadSessionStore = async (
  storePath: string,
): Promise<LoadedSessionStore> => {
  const emptyStore = {
    cleanupPaths: [],
    linkedAccount: null,
    loadIssue: null,
    notificationPreferences: null,
    sessions: [],
  } satisfies LoadedSessionStore;

  try {
    const raw = await readFile(storePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (!isSessionStorePayload(parsed)) {
      return {
        ...emptyStore,
        loadIssue: "invalid_store",
      };
    }

    return {
      cleanupPaths: parsed.cleanupPaths ?? [],
      linkedAccount: parsed.linkedAccount ?? null,
      loadIssue: null,
      notificationPreferences: parsed.notificationPreferences ?? null,
      sessions: parsed.sessions,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyStore;
    }

    return {
      ...emptyStore,
      loadIssue: "unreadable_store",
    };
  }
};

export const persistSessionStore = async ({
  cleanupPaths,
  linkedAccount,
  notificationPreferences,
  sessions,
  storePath,
}: {
  cleanupPaths: string[];
  linkedAccount: LinkedAccountSnapshot | null;
  notificationPreferences: DesktopNotificationPreferences;
  sessions: PersistedDesktopSession[];
  storePath: string;
}) => {
  await mkdir(dirname(storePath), { recursive: true });

  const tempPath = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload: SessionStorePayload = {
    cleanupPaths,
    linkedAccount,
    notificationPreferences,
    sessions,
  };

  await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
  await chmod(tempPath, 0o600).catch((_error: unknown) => null);
  await rename(tempPath, storePath);
  await chmod(storePath, 0o600).catch((_error: unknown) => null);
};

export type { PersistedDesktopSession, SessionStoreLoadIssue };
