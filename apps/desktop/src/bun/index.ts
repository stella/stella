import type { BrowserWindow as BrowserWindowType } from "electrobun/bun";
import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Tray,
  Updater,
  Utils,
} from "electrobun/bun";

import {
  resolveDesktopAllowedOrigins,
  resolveDesktopBridgePort,
  resolveDesktopViewPort,
} from "../dev-config";
import type { AppSnapshot, DesktopRPC, OpenDocxRequest } from "../shared/rpc";
import { DesktopSessionManager } from "./session-manager";

const DEV_SERVER_PORT = resolveDesktopViewPort();
const DEV_SERVER_URL = `http://127.0.0.1:${String(DEV_SERVER_PORT)}`;
const DESKTOP_BRIDGE_PORT = resolveDesktopBridgePort();
const isMac = process.platform === "darwin";
const DEFAULT_TAB = "general";
const OPEN_SESSION_ACTION_PREFIX = "session-open:";
const REVEAL_SESSION_ACTION_PREFIX = "session-reveal:";
const FINISH_SESSION_ACTION_PREFIX = "session-finish:";
const RETRY_SESSION_ACTION_PREFIX = "session-retry:";
const APPLY_UPDATE_ACTION = "apply-update";
const COPY_DIAGNOSTICS_ACTION = "copy-diagnostics";
const DOWNLOAD_UPDATE_ACTION = "download-update";
const EMAIL_SUPPORT_ACTION = "email-support";
const OPEN_ABOUT_ACTION = "open-about";
const CHECK_FOR_UPDATES_ACTION = "check-for-updates";
const OPEN_EDIT_ROOT_ACTION = "open-edit-root";
const OPEN_PREFERENCES_ACTION = "open-preferences";
const OPEN_SUPPORT_ROOT_ACTION = "open-support-root";
const QUIT_ACTION = "quit";
const bridgeAllowedOrigins = resolveDesktopAllowedOrigins();

type PreferencesTab = "general" | "notifications" | "about";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getEventAction = (event: unknown) => {
  if (!isRecord(event)) {
    return "";
  }

  const data = event.data;
  if (!isRecord(data)) {
    return "";
  }

  return typeof data.action === "string" ? data.action : "";
};

const getSessionIdFromAction = (action: string, prefix: string) => {
  if (!action.startsWith(prefix)) {
    return null;
  }

  const sessionId = action.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
};

const isOpenDocxRequest = (value: unknown): value is OpenDocxRequest => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.apiBaseUrl === "string" &&
    typeof value.entityId === "string" &&
    (value.linkedAccount === null ||
      (isRecord(value.linkedAccount) &&
        typeof value.linkedAccount.email === "string" &&
        (typeof value.linkedAccount.name === "string" ||
          value.linkedAccount.name === null) &&
        typeof value.linkedAccount.verifiedAt === "string")) &&
    typeof value.propertyId === "string" &&
    isRecord(value.remoteSession) &&
    typeof value.remoteSession.baseVersionNumber === "number" &&
    typeof value.remoteSession.downloadUrl === "string" &&
    typeof value.remoteSession.fileName === "string" &&
    (typeof value.remoteSession.lastCheckpointAt === "string" ||
      value.remoteSession.lastCheckpointAt === null) &&
    typeof value.remoteSession.resumedFromCheckpoint === "boolean" &&
    typeof value.remoteSession.sessionId === "string" &&
    typeof value.remoteSession.sessionToken === "string" &&
    typeof value.remoteSession.tookOverExistingSession === "boolean" &&
    typeof value.workspaceId === "string"
  );
};

const isAllowedBridgeOrigin = (origin: string | null) =>
  origin !== null && bridgeAllowedOrigins.has(origin);

const createJsonHeaders = (origin: string | null) => ({
  ...(isAllowedBridgeOrigin(origin)
    ? {
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": origin ?? "",
        Vary: "Origin",
      }
    : {}),
  "Content-Type": "application/json",
});

const jsonResponse = (
  status: number,
  payload: object,
  origin: string | null = null,
) =>
  new Response(JSON.stringify(payload), {
    headers: createJsonHeaders(origin),
    status,
  });

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return DEV_SERVER_URL;
    } catch {
      // Fall back to the bundled desktop view when Vite is not running.
    }
  }

  return "views://mainview/index.html";
}

let mainWindow: BrowserWindowType | null = null;
const mainViewUrl = await getMainViewUrl();
const activateMainWindowTab = (tab: PreferencesTab) => {
  if (!mainWindow) {
    return;
  }

  const activateTab = mainWindow.webview.rpc.send.activateTab;
  if (!activateTab) {
    return;
  }

  activateTab({ tab });
};

const formatMenuSessionStatus = (session: AppSnapshot["sessions"][number]) => {
  if (session.takeoverDetected) {
    return "Moved to another device";
  }

  switch (session.status) {
    case "error":
      return "Needs attention";
    case "finalizing":
      return "Creating final revision";
    case "opening":
      return "Opening in Word";
    case "ready":
      return session.pendingFinalize ? "Finishing edit" : "Editing live";
    case "syncing":
      return session.pendingFinalize ? "Finishing edit" : "Saving draft";
    default:
      return session.status;
  }
};

const canRetrySession = (session: AppSnapshot["sessions"][number]) =>
  !session.takeoverDetected &&
  (session.status === "error" || session.pendingFinalize);

const getTrayStatusLabel = (snapshot: AppSnapshot) => {
  if (snapshot.update.updateReady) {
    return "🟢 stella desktop update ready";
  }

  if (snapshot.update.updateAvailable) {
    return "🟢 stella desktop update available";
  }

  const needsAttention = snapshot.sessions.some(
    (session) => session.takeoverDetected || session.status === "error",
  );
  if (needsAttention) {
    return "🔴 stella desktop needs attention";
  }

  const activeSyncs = snapshot.sessions.filter(
    (session) =>
      session.status === "syncing" || session.status === "finalizing",
  ).length;
  if (activeSyncs > 0) {
    return `🟡 ${String(activeSyncs)} document${activeSyncs === 1 ? "" : "s"} syncing`;
  }

  return "🟢 stella desktop is running";
};

const buildTrayMenu = (snapshot: AppSnapshot) => {
  const activeSessions = snapshot.sessions.length;
  const statusDetail = snapshot.update.updateReady
    ? `Version ${snapshot.update.latestVersion ?? "available"} is ready to install`
    : snapshot.update.updateAvailable
      ? `Version ${snapshot.update.latestVersion ?? "available"} is ready to download`
      : activeSessions > 0
        ? `${String(activeSessions)} active desktop ${activeSessions === 1 ? "edit" : "edits"}`
        : "Waiting for documents from stella";

  const sessionItems =
    activeSessions === 0
      ? [{ enabled: false, label: "No active edits", type: "normal" as const }]
      : snapshot.sessions.map((session) => ({
          action: OPEN_SESSION_ACTION_PREFIX + session.id,
          label: session.fileName,
          submenu: [
            {
              enabled: false,
              label: formatMenuSessionStatus(session),
              type: "normal" as const,
            },
            { type: "divider" as const },
            {
              action: OPEN_SESSION_ACTION_PREFIX + session.id,
              label: "Open file",
              type: "normal" as const,
            },
            {
              action: REVEAL_SESSION_ACTION_PREFIX + session.id,
              label: "Reveal in folder",
              type: "normal" as const,
            },
            {
              action: FINISH_SESSION_ACTION_PREFIX + session.id,
              enabled: !session.takeoverDetected,
              label: "Finish editing",
              type: "normal" as const,
            },
            {
              action: RETRY_SESSION_ACTION_PREFIX + session.id,
              enabled: canRetrySession(session),
              label: "Retry now",
              type: "normal" as const,
            },
          ],
          tooltip: session.filePath,
          type: "normal" as const,
        }));

  return [
    {
      enabled: false,
      label: getTrayStatusLabel(snapshot),
      type: "normal" as const,
    },
    {
      enabled: false,
      label: statusDetail,
      type: "normal" as const,
    },
    { type: "divider" as const },
    {
      action: OPEN_PREFERENCES_ACTION,
      label: "Settings",
      type: "normal" as const,
    },
    {
      action: CHECK_FOR_UPDATES_ACTION,
      enabled:
        snapshot.update.status !== "checking" &&
        snapshot.update.status !== "downloading" &&
        snapshot.update.status !== "applying",
      label:
        snapshot.update.status === "checking"
          ? "Checking for updates..."
          : "Check for updates",
      type: "normal" as const,
    },
    ...(snapshot.update.updateReady
      ? [
          {
            action: APPLY_UPDATE_ACTION,
            label: "Restart to update",
            type: "normal" as const,
          },
        ]
      : snapshot.update.updateAvailable
        ? [
            {
              action: DOWNLOAD_UPDATE_ACTION,
              enabled: snapshot.update.status !== "downloading",
              label:
                snapshot.update.status === "downloading"
                  ? "Downloading update..."
                  : "Download update",
              type: "normal" as const,
            },
          ]
        : []),
    {
      action: OPEN_EDIT_ROOT_ACTION,
      label: "Temporary working copies",
      type: "normal" as const,
    },
    {
      label: "Support",
      submenu: [
        {
          action: EMAIL_SUPPORT_ACTION,
          label: "Email support",
          type: "normal" as const,
        },
        { type: "divider" as const },
        {
          action: COPY_DIAGNOSTICS_ACTION,
          label: "Copy diagnostics",
          type: "normal" as const,
        },
        {
          action: OPEN_SUPPORT_ROOT_ACTION,
          label: "Reveal app data",
          type: "normal" as const,
        },
      ],
      type: "normal" as const,
    },
    {
      label: "Active edits",
      submenu: sessionItems,
      type: "normal" as const,
    },
    { type: "divider" as const },
    {
      action: OPEN_ABOUT_ACTION,
      label: "About stella desktop",
      type: "normal" as const,
    },
    { type: "divider" as const },
    {
      action: QUIT_ACTION,
      label: "Quit stella desktop",
      type: "normal" as const,
    },
  ];
};

const setMacApplicationMenu = () => {
  if (!isMac) {
    return;
  }

  ApplicationMenu.setApplicationMenu([
    {
      label: "stella desktop",
      submenu: [
        {
          action: OPEN_ABOUT_ACTION,
          label: "About stella desktop",
          type: "normal",
        },
        { type: "divider" },
        {
          action: OPEN_PREFERENCES_ACTION,
          label: "Settings",
          type: "normal",
        },
        {
          action: CHECK_FOR_UPDATES_ACTION,
          label: "Check for updates",
          type: "normal",
        },
        { type: "divider" },
        {
          action: QUIT_ACTION,
          label: "Quit stella desktop",
          type: "normal",
        },
      ],
    },
  ]);
};

const tray = new Tray({
  height: 16,
  image: "views://assets/tray-icon-32-template.png",
  template: true,
  width: 16,
});

if (isMac) {
  Utils.setDockIconVisible(false);
  setMacApplicationMenu();
}

const sessionManager = new DesktopSessionManager({
  onStateChange: (snapshot) => {
    tray.setMenu(buildTrayMenu(snapshot));
  },
});
await sessionManager.initialize();
tray.setMenu(buildTrayMenu(sessionManager.getSnapshot()));

const rpc = BrowserView.defineRPC<DesktopRPC>({
  handlers: {
    messages: {},
    requests: {
      getState: () => sessionManager.getSnapshot(),
      updateNotificationPreferences: async ({
        notificationPreferences,
      }: {
        notificationPreferences: AppSnapshot["notificationPreferences"];
      }) =>
        await sessionManager.updateNotificationPreferences(
          notificationPreferences,
        ),
      checkForUpdates: async () => await sessionManager.checkForUpdates(),
      downloadUpdate: async () => await sessionManager.downloadUpdate(),
      applyUpdate: async () => await sessionManager.applyUpdate(),
      copyDiagnostics: () => sessionManager.copyDiagnostics(),
      emailSupport: () => sessionManager.emailSupport(),
      revealSupportRoot: () => sessionManager.revealSupportRoot(),
      openEditRoot: async () => await sessionManager.openEditRoot(),
      openSessionFile: ({ sessionId }: { sessionId: string }) =>
        sessionManager.openSessionFile(sessionId),
      revealSession: ({ sessionId }: { sessionId: string }) =>
        sessionManager.revealSession(sessionId),
      finishSession: ({ sessionId }: { sessionId: string }) =>
        sessionManager.finishSession(sessionId),
      retrySession: ({ sessionId }: { sessionId: string }) =>
        sessionManager.retrySessionNow(sessionId),
    },
  },
});

const ensureMainWindow = (tab: PreferencesTab = DEFAULT_TAB) => {
  if (mainWindow) {
    activateMainWindowTab(tab);
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    frame: {
      height: 460,
      width: 480,
      x: 240,
      y: 120,
    },
    rpc,
    styleMask: isMac
      ? {
          Miniaturizable: false,
          Resizable: false,
          UtilityWindow: true,
        }
      : {
          Resizable: false,
        },
    title: "stella desktop",
    titleBarStyle: "hiddenInset",
    url: mainViewUrl,
  });

  const windowRef = mainWindow;
  windowRef.webview.on("dom-ready", () => {
    if (mainWindow !== windowRef) {
      return;
    }

    activateMainWindowTab(tab);
  });
  windowRef.on("close", () => {
    if (mainWindow === windowRef) {
      mainWindow = null;
    }
  });

  return windowRef;
};

const handleMenuAction = (action: string) => {
  if (action === QUIT_ACTION) {
    void (async () => {
      await sessionManager.shutdown();
      Utils.quit();
    })();
    return true;
  }

  if (action === OPEN_PREFERENCES_ACTION) {
    ensureMainWindow("general");
    return true;
  }

  if (action === OPEN_ABOUT_ACTION) {
    ensureMainWindow("about");
    return true;
  }

  if (action === CHECK_FOR_UPDATES_ACTION) {
    void sessionManager.checkForUpdates();
    return true;
  }

  if (action === DOWNLOAD_UPDATE_ACTION) {
    void sessionManager.downloadUpdate();
    return true;
  }

  if (action === APPLY_UPDATE_ACTION) {
    void sessionManager.applyUpdate();
    return true;
  }

  if (action === OPEN_EDIT_ROOT_ACTION) {
    void sessionManager.openEditRoot();
    return true;
  }

  if (action === COPY_DIAGNOSTICS_ACTION) {
    void sessionManager.copyDiagnostics();
    return true;
  }

  if (action === EMAIL_SUPPORT_ACTION) {
    void sessionManager.emailSupport();
    return true;
  }

  if (action === OPEN_SUPPORT_ROOT_ACTION) {
    void sessionManager.revealSupportRoot();
    return true;
  }

  const openSessionId = getSessionIdFromAction(
    action,
    OPEN_SESSION_ACTION_PREFIX,
  );
  if (openSessionId) {
    void sessionManager.openSessionFile(openSessionId);
    return true;
  }

  const revealSessionId = getSessionIdFromAction(
    action,
    REVEAL_SESSION_ACTION_PREFIX,
  );
  if (revealSessionId) {
    void sessionManager.revealSession(revealSessionId);
    return true;
  }

  const finishSessionId = getSessionIdFromAction(
    action,
    FINISH_SESSION_ACTION_PREFIX,
  );
  if (finishSessionId) {
    void sessionManager.finishSession(finishSessionId);
    return true;
  }

  const retrySessionId = getSessionIdFromAction(
    action,
    RETRY_SESSION_ACTION_PREFIX,
  );
  if (retrySessionId) {
    void sessionManager.retrySessionNow(retrySessionId);
    return true;
  }

  return false;
};

tray.on("tray-clicked", (event) => {
  const action = getEventAction(event);
  const handled = handleMenuAction(action);
  if (!handled) {
    ensureMainWindow("general");
  }
});

ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const action = getEventAction(event);
  void handleMenuAction(action);
});

if (!isMac) {
  ensureMainWindow();
}

Bun.serve({
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowedOrigin = isAllowedBridgeOrigin(origin);

    if (request.method === "OPTIONS") {
      if (!allowedOrigin) {
        return jsonResponse(
          403,
          {
            message: "Desktop bridge origin is not allowed.",
          },
          origin,
        );
      }

      return new Response(null, {
        headers: createJsonHeaders(origin),
      });
    }

    if (pathname === "/health" && request.method === "GET") {
      if (origin !== null && !allowedOrigin) {
        return jsonResponse(
          403,
          {
            message: "Desktop bridge origin is not allowed.",
          },
          origin,
        );
      }

      return jsonResponse(
        200,
        {
          bridgePort: DESKTOP_BRIDGE_PORT,
          ok: true,
        },
        origin,
      );
    }

    if (
      request.method === "POST" &&
      pathname === "/v1/open-docx" &&
      !allowedOrigin
    ) {
      return jsonResponse(
        403,
        {
          message:
            "Desktop bridge only accepts requests from allowed stella origins.",
        },
        origin,
      );
    }

    if (pathname !== "/v1/open-docx" || request.method !== "POST") {
      return jsonResponse(
        404,
        {
          message: "Not found",
        },
        origin,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        400,
        {
          message: "Malformed JSON payload",
        },
        origin,
      );
    }

    if (!isOpenDocxRequest(body)) {
      return jsonResponse(
        400,
        {
          message: "Invalid open-docx payload",
        },
        origin,
      );
    }

    try {
      const result = await sessionManager.openDocx(body);
      return jsonResponse(200, result, origin);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "stella desktop could not open the document.";

      return jsonResponse(
        500,
        {
          message,
        },
        origin,
      );
    }
  },
  hostname: "127.0.0.1",
  port: DESKTOP_BRIDGE_PORT,
});
