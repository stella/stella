import { Updater, Utils } from "electrobun/bun";
import type { UpdateStatusEntry } from "electrobun/bun";
import { stat, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  AppSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  LinkedAccountSnapshot,
  OpenDocxRemoteSession,
  OpenDocxRequest,
  OpenDocxResponse,
} from "../shared/rpc";
import { DOCX_MIME_TYPE, STELLA_DESKTOP_BRIDGE_PORT } from "../shared/rpc";
import type {
  PersistedDesktopSession,
  SessionStoreLoadIssue,
} from "./session-store";
import { loadSessionStore, persistSessionStore } from "./session-store";

type DesktopSession = PersistedDesktopSession & {
  autoFinalizeTimer: ReturnType<typeof setTimeout> | null;
  checkpointInFlight: boolean;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  finalizeInFlight: boolean;
  retryNoticeShown: boolean;
  watcher: FSWatcher | null;
  wordLockSeen: boolean;
};

type CheckpointResponse = {
  checkpointedAt: string;
  noop: boolean;
};

type ErrorResponse = {
  code?: string;
  message?: string;
};

type FinalizeResponse =
  | {
      entityId: string;
      outcome: "finalized";
      versionNumber: number;
    }
  | {
      outcome: "no_changes";
    };

type DesktopSessionManagerOptions = {
  onStateChange?: (snapshot: AppSnapshot) => void;
};

const AUTO_FINALIZE_DELAY_MS = 2500;
const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECKPOINT_DEBOUNCE_MS = 1200;
const DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE = "desktop_edit_session_taken_over";
const DEFAULT_NOTIFICATION_PREFERENCES = {
  documentReady: true,
  revisionCreated: true,
  syncIssues: true,
} satisfies DesktopNotificationPreferences;
const DEFAULT_UPDATE_SNAPSHOT = {
  baseUrl: null,
  channel: null,
  currentHash: null,
  currentVersion: null,
  lastCheckedAt: null,
  latestHash: null,
  latestVersion: null,
  status: "idle",
  statusMessage: "Update checks are not configured yet.",
  updateAvailable: false,
  updateReady: false,
} satisfies DesktopUpdateSnapshot;
const LOCAL_EDIT_ROOT = join(Utils.paths.userData, "editing");
const REMOTE_SESSION_OPEN_TIMEOUT_MS = 20_000;
const REMOTE_SESSION_SAVE_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 15_000;
const SESSION_STORE_PATH = join(
  Utils.paths.userData,
  "desktop-edit-sessions.json",
);
const SUPPORT_EMAIL = "hello@stll.app";
const SUPPORT_ROOT = Utils.paths.userData;
const WORD_LOCK_PREFIX = "~$";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNullableString = (value: unknown): value is string | null =>
  typeof value === "string" || value === null;

const isUuidString = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

const isOpenDocxRemoteSession = (
  value: unknown,
): value is OpenDocxRemoteSession => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.baseVersionNumber === "number" &&
    typeof value.downloadUrl === "string" &&
    typeof value.fileName === "string" &&
    isNullableString(value.lastCheckpointAt) &&
    typeof value.resumedFromCheckpoint === "boolean" &&
    isUuidString(value.sessionId) &&
    typeof value.sessionToken === "string" &&
    typeof value.tookOverExistingSession === "boolean"
  );
};

const isCheckpointResponse = (value: unknown): value is CheckpointResponse => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.checkpointedAt === "string" && typeof value.noop === "boolean"
  );
};

const isErrorResponse = (value: unknown): value is ErrorResponse => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    ("code" in value ? typeof value.code === "string" : true) &&
    ("message" in value ? typeof value.message === "string" : true)
  );
};

const isFinalizeResponse = (value: unknown): value is FinalizeResponse => {
  if (!isRecord(value) || typeof value.outcome !== "string") {
    return false;
  }

  if (value.outcome === "no_changes") {
    return true;
  }

  return (
    value.outcome === "finalized" &&
    typeof value.entityId === "string" &&
    typeof value.versionNumber === "number"
  );
};

const normalizeApiBaseUrl = (apiBaseUrl: string) =>
  apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;

// Mirror the API-side filename sanitization and force a basename so
// desktop-managed copies cannot escape their per-session folder.
// eslint-disable-next-line no-control-regex -- intentional: strip null byte and other unsafe characters
const UNSAFE_FILE_NAME_CHARS_RE = /["/\\<>\r\n\u0000|*?:]/g;
const PATH_TRAVERSAL_RE = /\.\./g;
const LEADING_TRAILING_DOTS_RE = /^\.+|\.+$/g;
const DEFAULT_MANAGED_DOCX_NAME = "document.docx";

const sanitizeManagedFileName = (name: string) => {
  const sanitized = basename(name)
    .replace(UNSAFE_FILE_NAME_CHARS_RE, "_")
    .replace(PATH_TRAVERSAL_RE, "__")
    .replace(LEADING_TRAILING_DOTS_RE, "_");

  return sanitized.length > 0 ? sanitized : DEFAULT_MANAGED_DOCX_NAME;
};

const sessionKey = ({
  entityId,
  propertyId,
  workspaceId,
}: Pick<OpenDocxRequest, "entityId" | "propertyId" | "workspaceId">) =>
  `${workspaceId}:${entityId}:${propertyId}`;

const hashBuffer = (buffer: ArrayBuffer | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(buffer).digest("hex");

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

const fileExists = async (filePath: string) =>
  await new Promise<boolean>((resolve) => {
    stat(filePath, (error) => {
      resolve(!error);
    });
  });

const didRemoteCheckpointAdvance = ({
  localCheckpointAt,
  remoteCheckpointAt,
}: {
  localCheckpointAt: string | null;
  remoteCheckpointAt: string | null;
}) => {
  if (remoteCheckpointAt === null) {
    return false;
  }

  if (localCheckpointAt === null) {
    return true;
  }

  const remoteTimestamp = Date.parse(remoteCheckpointAt);
  const localTimestamp = Date.parse(localCheckpointAt);

  if (Number.isNaN(remoteTimestamp) || Number.isNaN(localTimestamp)) {
    return remoteCheckpointAt !== localCheckpointAt;
  }

  return remoteTimestamp > localTimestamp;
};

const jsonHeaders = {
  "Content-Type": "application/json",
};

const parseErrorResponse = async (response: Response) => {
  try {
    const payload: unknown = await response.json();
    if (!isErrorResponse(payload)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
};

const toPersistedSession = ({
  autoFinalizeTimer: _autoFinalizeTimer,
  checkpointInFlight: _checkpointInFlight,
  checkpointTimer: _checkpointTimer,
  finalizeInFlight: _finalizeInFlight,
  retryNoticeShown: _retryNoticeShown,
  watcher: _watcher,
  wordLockSeen: _wordLockSeen,
  ...session
}: DesktopSession): PersistedDesktopSession => session;

export class DesktopSessionManager {
  private readonly cleanupPaths = new Set<string>();
  private readonly openDocxLocks = new Map<string, Promise<void>>();
  private persistSessionsPromise: Promise<void> = Promise.resolve();

  private linkedAccount: LinkedAccountSnapshot | null = null;

  private notificationPreferences: DesktopNotificationPreferences =
    DEFAULT_NOTIFICATION_PREFERENCES;

  private readonly onStateChange?: DesktopSessionManagerOptions["onStateChange"];

  private readonly runningSince = new Date().toISOString();

  private readonly sessionIdsByKey = new Map<string, string>();

  private readonly sessions = new Map<string, DesktopSession>();

  private storeLoadIssue: SessionStoreLoadIssue | null = null;

  private update: DesktopUpdateSnapshot = DEFAULT_UPDATE_SNAPSHOT;

  private readonly retryIntervalId: ReturnType<typeof setInterval>;

  private readonly updateIntervalId: ReturnType<typeof setInterval>;

  public constructor({ onStateChange }: DesktopSessionManagerOptions = {}) {
    this.onStateChange = onStateChange;
    this.retryIntervalId = setInterval(() => {
      void this.retryPendingWork();
    }, RETRY_INTERVAL_MS);
    this.updateIntervalId = setInterval(() => {
      void this.checkForUpdates({ background: true });
    }, AUTO_UPDATE_CHECK_INTERVAL_MS);
  }

  public async initialize() {
    await this.initializeUpdater();
    const persistedStore = await loadSessionStore(SESSION_STORE_PATH);
    this.linkedAccount = persistedStore.linkedAccount ?? null;
    this.notificationPreferences =
      persistedStore.notificationPreferences ??
      DEFAULT_NOTIFICATION_PREFERENCES;
    this.storeLoadIssue = persistedStore.loadIssue;

    if (this.storeLoadIssue) {
      this.showNotification("syncIssues", {
        body: "stella desktop reset its local recovery state after a storage error. Reopen any draft from stella if needed.",
        title: "Local recovery data was reset",
      });
    }

    for (const cleanupPath of persistedStore.cleanupPaths ?? []) {
      this.cleanupPaths.add(cleanupPath);
    }

    const persistedSessions = persistedStore.sessions;

    for (const persistedSession of persistedSessions) {
      if (!(await fileExists(persistedSession.filePath))) {
        continue;
      }

      const session: DesktopSession = {
        ...persistedSession,
        autoFinalizeTimer: null,
        checkpointInFlight: false,
        checkpointTimer: null,
        finalizeInFlight: false,
        retryNoticeShown: false,
        watcher: null,
        wordLockSeen: false,
      };

      this.sessions.set(session.id, session);
      this.sessionIdsByKey.set(session.key, session.id);
      await this.attachWatcher(session.id);
      if (!session.pendingFinalize && !session.wordLockSeen) {
        this.scheduleAutoFinalize(session.id);
      }
      void this.retrySession(session.id);
    }

    await this.retryPendingCleanup();
    this.emitStateChange();
    await this.persistSessions();
    void this.checkForUpdates({ background: true });
  }

  public async shutdown() {
    clearInterval(this.retryIntervalId);
    clearInterval(this.updateIntervalId);
    Updater.onStatusChange(null);
    await this.persistSessions();

    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        await this.retrySession(session.id);
      }),
    );
  }

  public getSnapshot(): AppSnapshot {
    const sessions = [...this.sessions.values()]
      .map((session) => ({
        baseVersionNumber: session.baseVersionNumber,
        entityId: session.entityId,
        fileName: session.fileName,
        filePath: session.filePath,
        id: session.id,
        lastCheckpointAt: session.lastCheckpointAt,
        lastError: session.lastError,
        pendingFinalize: session.pendingFinalize,
        propertyId: session.propertyId,
        status: session.status,
        takeoverDetected: session.takeoverDetected,
        workspaceId: session.workspaceId,
      }))
      .toSorted((left, right) => left.fileName.localeCompare(right.fileName));

    return {
      bridgePort: STELLA_DESKTOP_BRIDGE_PORT,
      linkedAccount: this.linkedAccount,
      notificationPreferences: this.notificationPreferences,
      runningSince: this.runningSince,
      sessions,
      update: this.update,
    };
  }

  public async openDocx(request: OpenDocxRequest): Promise<OpenDocxResponse> {
    const key = sessionKey(request);
    return await this.withOpenDocxLock(key, async () => {
      const remoteSession = request.remoteSession;
      if (!isOpenDocxRemoteSession(remoteSession)) {
        throw new Error(
          "stella desktop received an invalid open-session response.",
        );
      }

      const managedFileName = sanitizeManagedFileName(remoteSession.fileName);
      await this.syncLinkedAccount(request.linkedAccount);
      const existingLocalSessionId = this.sessionIdsByKey.get(key);
      const existingLocalSession = existingLocalSessionId
        ? (this.sessions.get(existingLocalSessionId) ?? null)
        : null;
      const shouldReuseExistingLocalCopy =
        existingLocalSession !== null &&
        existingLocalSession.id === remoteSession.sessionId &&
        (await fileExists(existingLocalSession.filePath)) &&
        !didRemoteCheckpointAdvance({
          localCheckpointAt: existingLocalSession.lastCheckpointAt,
          remoteCheckpointAt: remoteSession.lastCheckpointAt,
        });

      if (shouldReuseExistingLocalCopy && existingLocalSession !== null) {
        existingLocalSession.apiBaseUrl = normalizeApiBaseUrl(
          request.apiBaseUrl,
        );
        existingLocalSession.baseVersionNumber =
          remoteSession.baseVersionNumber;
        existingLocalSession.fileName = managedFileName;
        existingLocalSession.lastCheckpointAt = remoteSession.lastCheckpointAt;
        existingLocalSession.lastError = null;
        existingLocalSession.pendingFinalize = false;
        existingLocalSession.retryNoticeShown = false;
        existingLocalSession.sessionToken = remoteSession.sessionToken;
        existingLocalSession.status = "ready";
        existingLocalSession.takeoverDetected = false;
        await this.persistSessions();
        this.emitStateChange();

        const opened = Utils.openPath(existingLocalSession.filePath);
        if (!opened) {
          throw new Error("stella desktop could not re-open the local file.");
        }

        this.showNotification("documentReady", {
          body: existingLocalSession.fileName,
          subtitle: "Already open",
          title: "stella desktop",
        });

        return {
          alreadyOpen: true,
          filePath: existingLocalSession.filePath,
          sessionId: existingLocalSession.id,
        };
      }

      const nextManagedCopyFolderName =
        existingLocalSession !== null &&
        existingLocalSession.id === remoteSession.sessionId &&
        (await fileExists(existingLocalSession.filePath))
          ? `${remoteSession.sessionId}-${crypto.randomUUID()}`
          : remoteSession.sessionId;

      const download = await this.downloadDocx(remoteSession.downloadUrl);
      const normalizedApiBaseUrl = normalizeApiBaseUrl(request.apiBaseUrl);
      const localSha = hashBuffer(download.buffer);
      const filePath = await this.writeManagedCopy({
        buffer: download.buffer,
        fileName: managedFileName,
        folderName: nextManagedCopyFolderName,
      });

      const session: DesktopSession = {
        apiBaseUrl: normalizedApiBaseUrl,
        autoFinalizeTimer: null,
        baseVersionNumber: remoteSession.baseVersionNumber,
        checkpointInFlight: false,
        checkpointTimer: null,
        entityId: request.entityId,
        fileName: managedFileName,
        filePath,
        finalizeInFlight: false,
        id: remoteSession.sessionId,
        key,
        lastCheckpointAt: remoteSession.lastCheckpointAt,
        lastCheckpointSha: remoteSession.resumedFromCheckpoint
          ? localSha
          : null,
        lastError: null,
        lastLocalSha: localSha,
        pendingFinalize: false,
        propertyId: request.propertyId,
        retryNoticeShown: false,
        sessionToken: remoteSession.sessionToken,
        status: "opening",
        takeoverDetected: false,
        watcher: null,
        wordLockSeen: false,
        workspaceId: request.workspaceId,
      };

      if (existingLocalSession) {
        await this.cleanupSession(existingLocalSession.id);
      }

      this.sessions.set(session.id, session);
      this.sessionIdsByKey.set(key, session.id);
      await this.attachWatcher(session.id);
      await this.persistSessions();
      this.emitStateChange();

      const opened = Utils.openPath(filePath);
      if (!opened) {
        await this.cleanupSession(session.id);
        throw new Error("stella desktop could not open the local DOCX file.");
      }

      session.status = "ready";
      await this.persistSessions();
      this.emitStateChange();

      this.showNotification("documentReady", {
        body: `${session.fileName} is ready to edit.`,
        subtitle: remoteSession.tookOverExistingSession
          ? "Editing resumed on this device"
          : remoteSession.resumedFromCheckpoint
            ? "Recovered latest draft"
            : "Save normally",
        title: "Opened in stella desktop",
      });

      return {
        alreadyOpen: false,
        filePath,
        sessionId: session.id,
      };
    });
  }

  public openSessionFile(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    return Utils.openPath(session.filePath);
  }

  public async updateNotificationPreferences(
    notificationPreferences: DesktopNotificationPreferences,
  ) {
    this.notificationPreferences = notificationPreferences;
    await this.persistSessions();
    this.emitStateChange();
    return this.getSnapshot();
  }

  public async checkForUpdates({
    background = false,
  }: { background?: boolean } = {}) {
    if (!this.canCheckForUpdates()) {
      this.update = {
        ...this.update,
        lastCheckedAt: new Date().toISOString(),
        status: "disabled",
        statusMessage:
          this.update.channel === "dev"
            ? "Update checks are disabled on the dev channel."
            : "Set STELLA_DESKTOP_RELEASE_BASE_URL before checking for updates.",
        updateAvailable: false,
        updateReady: false,
      };
      this.emitStateChange();
      return this.getSnapshot();
    }

    if (
      this.update.status === "checking" ||
      this.update.status === "downloading" ||
      this.update.status === "applying"
    ) {
      return this.getSnapshot();
    }

    const checkedAt = new Date().toISOString();
    this.update = {
      ...this.update,
      lastCheckedAt: checkedAt,
      status: "checking",
      statusMessage: background
        ? "Checking for updates in the background..."
        : "Checking for updates...",
    };
    this.emitStateChange();

    try {
      const result = await Updater.checkForUpdate();
      const nextStatus = result.error
        ? "error"
        : result.updateReady
          ? "ready"
          : result.updateAvailable
            ? "available"
            : "up_to_date";
      const statusMessage =
        result.error ||
        (result.updateReady
          ? `Update ${result.version} is ready to install.`
          : result.updateAvailable
            ? `Update ${result.version} is available.`
            : "stella desktop is up to date.");

      this.update = {
        ...this.update,
        lastCheckedAt: checkedAt,
        latestHash: result.hash || this.update.latestHash,
        latestVersion: result.version || this.update.latestVersion,
        status: nextStatus,
        statusMessage,
        updateAvailable: result.updateAvailable,
        updateReady: result.updateReady,
      };
      this.emitStateChange();
      return this.getSnapshot();
    } catch (error) {
      this.update = {
        ...this.update,
        lastCheckedAt: checkedAt,
        status: "error",
        statusMessage:
          error instanceof Error
            ? error.message
            : "stella desktop could not check for updates.",
        updateAvailable: false,
        updateReady: false,
      };
      this.emitStateChange();
      return this.getSnapshot();
    }
  }

  public async downloadUpdate() {
    if (!this.canCheckForUpdates()) {
      return this.getSnapshot();
    }

    if (this.update.updateReady) {
      return this.getSnapshot();
    }

    this.update = {
      ...this.update,
      status: "downloading",
      statusMessage: "Downloading update...",
    };
    this.emitStateChange();

    try {
      await Updater.downloadUpdate();
      return this.getSnapshot();
    } catch (error) {
      this.update = {
        ...this.update,
        status: "error",
        statusMessage:
          error instanceof Error
            ? error.message
            : "stella desktop could not download the update.",
      };
      this.emitStateChange();
      return this.getSnapshot();
    }
  }

  public async applyUpdate() {
    if (!this.update.updateReady) {
      return this.getSnapshot();
    }

    this.update = {
      ...this.update,
      status: "applying",
      statusMessage: "Restarting to apply the update...",
    };
    this.emitStateChange();

    try {
      await Updater.applyUpdate();
    } catch (error) {
      this.update = {
        ...this.update,
        status: "error",
        statusMessage:
          error instanceof Error
            ? error.message
            : "stella desktop could not apply the update.",
      };
      this.emitStateChange();
    }

    return this.getSnapshot();
  }

  public async openEditRoot() {
    await mkdir(LOCAL_EDIT_ROOT, { recursive: true });
    return Utils.openPath(LOCAL_EDIT_ROOT);
  }

  public revealSupportRoot() {
    return Utils.openPath(SUPPORT_ROOT);
  }

  public emailSupport() {
    const subject = encodeURIComponent("stella desktop support");
    return Utils.openExternal(`mailto:${SUPPORT_EMAIL}?subject=${subject}`);
  }

  public copyDiagnostics() {
    Utils.clipboardWriteText(this.getDiagnosticsText());
    this.showNotification("syncIssues", {
      body: "Paste it into your support request when needed.",
      title: "Diagnostics copied",
    });
    return true;
  }

  public revealSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    Utils.showItemInFolder(session.filePath);
    return true;
  }

  public finishSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return false;
    }

    session.pendingFinalize = true;
    session.lastError = null;
    session.status =
      session.lastLocalSha === session.lastCheckpointSha
        ? "finalizing"
        : "syncing";
    void this.persistSessions();
    this.emitStateChange();
    void this.retrySession(session.id);
    return true;
  }

  public retrySessionNow(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return false;
    }

    session.lastError = null;
    session.retryNoticeShown = false;

    if (session.pendingFinalize) {
      session.status =
        session.lastLocalSha === session.lastCheckpointSha
          ? "finalizing"
          : "syncing";
    }

    void this.persistSessions();
    this.emitStateChange();
    void this.retrySession(session.id);
    return true;
  }

  private emitStateChange() {
    this.onStateChange?.(this.getSnapshot());
  }

  private async attachWatcher(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return;
    }

    session.watcher?.close();
    session.wordLockSeen = await this.hasWordLockFile(session);
    session.watcher = watch(
      dirname(session.filePath),
      (_eventType, changedFile) => {
        void this.handleFilesystemEvent(
          session.id,
          typeof changedFile === "string" ? changedFile : null,
        );
      },
    );
  }

  private async handleFilesystemEvent(
    sessionId: string,
    changedFileName: string | null,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return;
    }

    const isManagedFileEvent =
      changedFileName === null || changedFileName === session.fileName;

    if (isManagedFileEvent) {
      // fs.watch may omit the filename during Word rename-style save cycles.
      // Keep this path conservative; checkpoint SHA comparison turns unrelated
      // directory events into no-op sync attempts once the file settles.
      this.scheduleCheckpoint(session.id);
    }

    const hasWordLockFile = await this.hasWordLockFile(session);

    if (hasWordLockFile) {
      if (session.autoFinalizeTimer) {
        clearTimeout(session.autoFinalizeTimer);
        session.autoFinalizeTimer = null;
      }

      session.wordLockSeen = true;
      return;
    }

    if (!session.wordLockSeen || session.pendingFinalize) {
      return;
    }

    session.wordLockSeen = false;
    this.scheduleAutoFinalize(session.id);
  }

  private scheduleCheckpoint(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return;
    }

    if (session.checkpointTimer) {
      clearTimeout(session.checkpointTimer);
    }

    session.checkpointTimer = setTimeout(() => {
      void this.retrySession(sessionId);
    }, CHECKPOINT_DEBOUNCE_MS);
  }

  private scheduleAutoFinalize(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return;
    }

    if (session.autoFinalizeTimer) {
      clearTimeout(session.autoFinalizeTimer);
    }

    session.autoFinalizeTimer = setTimeout(() => {
      const latestSession = this.sessions.get(sessionId);
      if (latestSession) {
        latestSession.autoFinalizeTimer = null;
      }

      if (
        !latestSession ||
        latestSession.pendingFinalize ||
        latestSession.takeoverDetected ||
        latestSession.wordLockSeen
      ) {
        return;
      }

      this.finishSession(sessionId);
    }, AUTO_FINALIZE_DELAY_MS);
  }

  private async retryPendingWork() {
    await this.retryPendingCleanup();

    for (const session of this.sessions.values()) {
      await this.retrySession(session.id);
    }
  }

  private async retrySession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.takeoverDetected) {
      return;
    }

    const checkpointReady = await this.syncCheckpoint(session.id);

    if (session.pendingFinalize && checkpointReady) {
      await this.finalizeSession(session.id);
    }
  }

  private isCurrentSessionToken(sessionId: string, sessionToken: string) {
    const session = this.sessions.get(sessionId);
    return session?.sessionToken === sessionToken;
  }

  private async syncCheckpoint(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.checkpointInFlight ||
      session.finalizeInFlight ||
      session.takeoverDetected
    ) {
      return false;
    }

    if (!(await fileExists(session.filePath))) {
      session.lastError = "The managed local file is missing.";
      session.status = "error";
      await this.persistSessions();
      this.emitStateChange();
      return false;
    }

    session.checkpointInFlight = true;
    session.lastError = null;
    session.status = "syncing";
    await this.persistSessions();
    this.emitStateChange();

    try {
      const fileBuffer = await Bun.file(session.filePath).arrayBuffer();
      const nextSha = hashBuffer(fileBuffer);
      session.lastLocalSha = nextSha;

      if (nextSha === session.lastCheckpointSha) {
        session.status = session.pendingFinalize ? "finalizing" : "ready";
        await this.persistSessions();
        this.emitStateChange();
        return true;
      }

      const formData = new FormData();
      const requestSessionToken = session.sessionToken;
      formData.set(
        "file",
        new File([fileBuffer], session.fileName, {
          type: DOCX_MIME_TYPE,
        }),
      );
      formData.set("sessionToken", requestSessionToken);

      const response = await fetch(
        `${session.apiBaseUrl}/v1/desktop-edit-sessions/${session.id}/checkpoint`,
        {
          body: formData,
          method: "POST",
          signal: withTimeout(REMOTE_SESSION_SAVE_TIMEOUT_MS),
        },
      );

      if (!response.ok) {
        const responseError = await parseErrorResponse(response);

        if (!this.isCurrentSessionToken(session.id, requestSessionToken)) {
          return false;
        }

        if (
          response.status === 409 &&
          responseError?.code === DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE
        ) {
          await this.markSessionTakenOver(
            session.id,
            responseError.message ?? "Desktop editing moved to another device.",
          );
          return false;
        }

        if (response.status === 409) {
          await this.closeRemoteSession(
            session.id,
            responseError?.message ?? "Desktop edit session is already closed.",
          );
          return false;
        }

        throw new Error(
          responseError?.message ??
            "stella desktop could not save the latest checkpoint.",
        );
      }

      const responseJson: unknown = await response.json();
      if (!isCheckpointResponse(responseJson)) {
        throw new Error(
          "stella desktop received an invalid checkpoint response.",
        );
      }

      session.lastCheckpointAt = responseJson.checkpointedAt;
      session.lastCheckpointSha = nextSha;
      session.lastError = null;
      session.retryNoticeShown = false;
      session.status = session.pendingFinalize ? "finalizing" : "ready";
      await this.persistSessions();
      this.emitStateChange();
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "stella desktop could not save the latest checkpoint.";

      session.lastError = message;
      session.status = "error";
      await this.persistSessions();
      this.emitStateChange();

      if (!session.retryNoticeShown) {
        session.retryNoticeShown = true;
        this.showNotification("syncIssues", {
          body: session.fileName,
          subtitle: "Changes stay local and will retry automatically",
          title: "Checkpoint sync delayed",
        });
      }

      return false;
    } finally {
      session.checkpointInFlight = false;
    }
  }

  private async finalizeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.finalizeInFlight || session.takeoverDetected) {
      return false;
    }

    if (session.lastLocalSha !== session.lastCheckpointSha) {
      return false;
    }

    session.finalizeInFlight = true;
    session.lastError = null;
    session.status = "finalizing";
    await this.persistSessions();
    this.emitStateChange();

    try {
      const requestSessionToken = session.sessionToken;
      const response = await fetch(
        `${session.apiBaseUrl}/v1/desktop-edit-sessions/${session.id}/finalize`,
        {
          body: JSON.stringify({
            sessionToken: requestSessionToken,
          }),
          headers: jsonHeaders,
          method: "POST",
          signal: withTimeout(REMOTE_SESSION_SAVE_TIMEOUT_MS),
        },
      );

      if (!this.isCurrentSessionToken(session.id, requestSessionToken)) {
        return false;
      }

      if (!response.ok) {
        const responseError = await parseErrorResponse(response);
        const message =
          responseError?.message ??
          "stella desktop could not finalize this edit.";

        if (
          response.status === 409 &&
          responseError?.code === DESKTOP_EDIT_SESSION_TAKEN_OVER_CODE
        ) {
          await this.markSessionTakenOver(session.id, message);
          return false;
        }

        if (response.status === 409) {
          await this.closeRemoteSession(session.id, message);
          return false;
        }

        throw new Error(message);
      }

      const responseJson: unknown = await response.json();
      if (!isFinalizeResponse(responseJson)) {
        throw new Error(
          "stella desktop received an invalid finalize response.",
        );
      }

      if (responseJson.outcome === "finalized") {
        this.showNotification("revisionCreated", {
          body: `${session.fileName} saved as version ${responseJson.versionNumber}.`,
          subtitle: "Desktop editing finished",
          title: "stella revision created",
        });
      }

      await this.cleanupSession(session.id, { removeLocalFiles: true });
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "stella desktop could not finalize this edit.";

      session.lastError = message;
      session.status = "error";
      await this.persistSessions();
      this.emitStateChange();

      if (!session.retryNoticeShown) {
        session.retryNoticeShown = true;
        this.showNotification("syncIssues", {
          body: session.fileName,
          subtitle: session.pendingFinalize
            ? "Your local copy stays preserved and finalize will retry"
            : "Your local copy stays preserved",
          title: "Desktop finalize delayed",
        });
      }

      return false;
    } finally {
      session.finalizeInFlight = false;
    }
  }

  private async markSessionTakenOver(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.checkpointTimer) {
      clearTimeout(session.checkpointTimer);
      session.checkpointTimer = null;
    }

    if (session.autoFinalizeTimer) {
      clearTimeout(session.autoFinalizeTimer);
      session.autoFinalizeTimer = null;
    }

    session.lastError = message;
    session.pendingFinalize = false;
    session.retryNoticeShown = false;
    session.status = "error";
    session.takeoverDetected = true;
    await this.persistSessions();
    this.emitStateChange();

    this.showNotification("syncIssues", {
      body: session.fileName,
      subtitle: "Reopen from stella here to take editing back",
      title: "Editing moved to another device",
    });
  }

  private async closeRemoteSession(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.showNotification("syncIssues", {
      body: session.fileName,
      subtitle: "Local copy stays preserved in Temporary working copies",
      title: message,
    });

    await this.cleanupSession(sessionId);
  }

  private async withOpenDocxLock<T>(key: string, task: () => Promise<T>) {
    const previousLock = (
      this.openDocxLocks.get(key) ?? Promise.resolve()
    ).catch(() => null);
    let releaseLock!: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const queuedLock = previousLock.then(async () => {
      await currentLock;
    });
    this.openDocxLocks.set(key, queuedLock);

    await previousLock;

    try {
      return await task();
    } finally {
      releaseLock();
      if (this.openDocxLocks.get(key) === queuedLock) {
        this.openDocxLocks.delete(key);
      }
    }
  }

  private async cleanupSession(
    sessionId: string,
    { removeLocalFiles = false }: { removeLocalFiles?: boolean } = {},
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.checkpointTimer) {
      clearTimeout(session.checkpointTimer);
    }

    if (session.autoFinalizeTimer) {
      clearTimeout(session.autoFinalizeTimer);
    }

    session.watcher?.close();
    this.sessions.delete(sessionId);
    this.sessionIdsByKey.delete(session.key);

    if (removeLocalFiles) {
      await this.scheduleCleanupPath(dirname(session.filePath));
    }

    await this.persistSessions();
    this.emitStateChange();
  }

  private async initializeUpdater() {
    Updater.onStatusChange((entry) => {
      this.handleUpdaterStatusChange(entry);
    });

    try {
      const [baseUrl, channel, currentHash, currentVersion] = await Promise.all(
        [
          Updater.localInfo.baseUrl(),
          Updater.localInfo.channel(),
          Updater.localInfo.hash(),
          Updater.localInfo.version(),
        ],
      );

      const hasConfiguredBaseUrl = baseUrl.trim().length > 0;
      this.update = {
        ...DEFAULT_UPDATE_SNAPSHOT,
        baseUrl: hasConfiguredBaseUrl ? baseUrl : null,
        channel,
        currentHash,
        currentVersion,
        status:
          channel === "dev"
            ? "disabled"
            : hasConfiguredBaseUrl
              ? "idle"
              : "disabled",
        statusMessage:
          channel === "dev"
            ? "Update checks are disabled on the dev channel."
            : hasConfiguredBaseUrl
              ? "Manual update checks are ready."
              : "Set STELLA_DESKTOP_RELEASE_BASE_URL to enable update checks.",
      };
    } catch (error) {
      this.update = {
        ...DEFAULT_UPDATE_SNAPSHOT,
        status: "error",
        statusMessage:
          error instanceof Error
            ? error.message
            : "stella desktop could not load updater metadata.",
      };
    }
  }

  private getDiagnosticsText() {
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      platform: {
        arch: process.arch,
        bunVersion: Bun.version,
        platform: process.platform,
      },
      app: {
        bridgePort: STELLA_DESKTOP_BRIDGE_PORT,
        runningSince: this.runningSince,
        supportRoot: SUPPORT_ROOT,
        temporaryWorkingCopiesRoot: LOCAL_EDIT_ROOT,
      },
      linkedAccount: this.linkedAccount
        ? {
            email: this.linkedAccount.email,
            name: this.linkedAccount.name,
            verifiedAt: this.linkedAccount.verifiedAt,
          }
        : null,
      storeLoadIssue: this.storeLoadIssue,
      notificationPreferences: this.notificationPreferences,
      update: this.update,
      sessions: [...this.sessions.values()].map((session) => ({
        hasLocalCopy: true,
        id: session.id,
        lastCheckpointAt: session.lastCheckpointAt,
        lastError: session.lastError,
        pendingFinalize: session.pendingFinalize,
        status: session.status,
        takeoverDetected: session.takeoverDetected,
      })),
      cleanupPathsQueued: this.cleanupPaths.size,
    };

    return JSON.stringify(diagnostics, null, 2);
  }

  private async persistSessions() {
    const payload = {
      cleanupPaths: [...this.cleanupPaths].toSorted(),
      linkedAccount: this.linkedAccount,
      notificationPreferences: this.notificationPreferences,
      sessions: [...this.sessions.values()].map(toPersistedSession),
      storePath: SESSION_STORE_PATH,
    } as const;

    const nextPersist = this.persistSessionsPromise
      .catch(() => null)
      .then(async () => {
        await persistSessionStore(payload);
      });

    this.persistSessionsPromise = nextPersist;
    await nextPersist;
  }

  private canCheckForUpdates() {
    return (
      this.update.channel !== null &&
      this.update.channel !== "dev" &&
      this.update.baseUrl !== null &&
      this.update.baseUrl.trim().length > 0
    );
  }

  private handleUpdaterStatusChange(entry: UpdateStatusEntry) {
    if (entry.status === "checking") {
      this.update = {
        ...this.update,
        status: "checking",
        statusMessage: entry.message,
      };
      this.emitStateChange();
      return;
    }

    if (
      entry.status === "download-starting" ||
      entry.status === "downloading" ||
      entry.status === "checking-local-tar" ||
      entry.status === "local-tar-found" ||
      entry.status === "local-tar-missing" ||
      entry.status === "fetching-patch" ||
      entry.status === "patch-found" ||
      entry.status === "patch-not-found" ||
      entry.status === "downloading-patch" ||
      entry.status === "applying-patch" ||
      entry.status === "patch-applied" ||
      entry.status === "extracting-version" ||
      entry.status === "patch-chain-complete" ||
      entry.status === "downloading-full-bundle" ||
      entry.status === "download-progress" ||
      entry.status === "decompressing"
    ) {
      this.update = {
        ...this.update,
        status: "downloading",
        statusMessage: entry.message,
      };
      this.emitStateChange();
      return;
    }

    if (entry.status === "download-complete" || entry.status === "complete") {
      this.update = {
        ...this.update,
        status: "ready",
        statusMessage: "Update is ready. Restart stella desktop to install it.",
        updateAvailable: true,
        updateReady: true,
      };
      this.emitStateChange();
      return;
    }

    if (
      entry.status === "applying" ||
      entry.status === "extracting" ||
      entry.status === "replacing-app" ||
      entry.status === "launching-new-version"
    ) {
      this.update = {
        ...this.update,
        status: "applying",
        statusMessage: entry.message,
      };
      this.emitStateChange();
      return;
    }

    if (entry.status === "update-available") {
      this.update = {
        ...this.update,
        latestHash: entry.details?.latestHash ?? this.update.latestHash,
        status: "available",
        statusMessage: entry.message,
        updateAvailable: true,
        updateReady: false,
      };
      this.emitStateChange();
      return;
    }

    if (entry.status === "no-update") {
      this.update = {
        ...this.update,
        status: this.canCheckForUpdates() ? "up_to_date" : "disabled",
        statusMessage: this.canCheckForUpdates()
          ? "stella desktop is up to date."
          : this.update.statusMessage,
        updateAvailable: false,
        updateReady: false,
      };
      this.emitStateChange();
      return;
    }

    if (entry.status === "error") {
      this.update = {
        ...this.update,
        status: "error",
        statusMessage: entry.message,
        updateAvailable: this.update.updateAvailable,
      };
      this.emitStateChange();
      return;
    }
  }

  private async retryPendingCleanup() {
    const activeSessionFolders = new Set(
      [...this.sessions.values()].map((session) => dirname(session.filePath)),
    );

    let changed = false;

    for (const cleanupPath of [...this.cleanupPaths]) {
      if (activeSessionFolders.has(cleanupPath)) {
        this.cleanupPaths.delete(cleanupPath);
        changed = true;
        continue;
      }

      const removed = await this.tryRemoveCleanupPath(cleanupPath);
      if (removed) {
        changed = true;
      }
    }

    if (changed) {
      await this.persistSessions();
    }
  }

  private async scheduleCleanupPath(cleanupPath: string) {
    const removed = await this.tryRemoveCleanupPath(cleanupPath);
    if (!removed) {
      this.cleanupPaths.add(cleanupPath);
    }
  }

  private async tryRemoveCleanupPath(cleanupPath: string) {
    try {
      await rm(cleanupPath, {
        force: false,
        recursive: true,
      });
      this.cleanupPaths.delete(cleanupPath);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        this.cleanupPaths.delete(cleanupPath);
        return true;
      }

      this.cleanupPaths.add(cleanupPath);
      return false;
    }
  }

  private async syncLinkedAccount(linkedAccount: LinkedAccountSnapshot | null) {
    if (linkedAccount === null) {
      return;
    }

    const didChange =
      this.linkedAccount?.email !== linkedAccount.email ||
      this.linkedAccount?.name !== linkedAccount.name ||
      this.linkedAccount?.verifiedAt !== linkedAccount.verifiedAt;

    if (!didChange) {
      return;
    }

    this.linkedAccount = linkedAccount;
    await this.persistSessions();
    this.emitStateChange();
  }

  private showNotification(
    type: keyof DesktopNotificationPreferences,
    options: Parameters<typeof Utils.showNotification>[0],
  ) {
    if (!this.notificationPreferences[type]) {
      return;
    }

    Utils.showNotification(options);
  }

  private async downloadDocx(downloadUrl: string) {
    const docxResponse = await fetch(downloadUrl, {
      signal: withTimeout(REMOTE_SESSION_OPEN_TIMEOUT_MS),
    });

    if (!docxResponse.ok) {
      throw new Error("stella desktop could not download the DOCX draft.");
    }

    return {
      buffer: await docxResponse.arrayBuffer(),
    };
  }

  private async writeManagedCopy({
    buffer,
    fileName,
    folderName,
  }: {
    buffer: ArrayBuffer;
    fileName: string;
    folderName: string;
  }) {
    const sessionFolder = join(LOCAL_EDIT_ROOT, folderName);
    await mkdir(sessionFolder, { recursive: true });

    const filePath = join(sessionFolder, fileName);
    await Bun.write(filePath, buffer);
    return filePath;
  }

  private async hasWordLockFile(session: DesktopSession) {
    try {
      const directoryEntries = await readdir(dirname(session.filePath));
      return directoryEntries.includes(
        `${WORD_LOCK_PREFIX}${session.fileName}`,
      );
    } catch {
      return false;
    }
  }
}
