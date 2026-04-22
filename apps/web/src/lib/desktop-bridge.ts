import { env } from "@/env";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

const DESKTOP_BRIDGE_PORT = env.VITE_DESKTOP_BRIDGE_PORT;
const DESKTOP_BRIDGE_URL = `http://127.0.0.1:${String(DESKTOP_BRIDGE_PORT)}`;

export class DesktopBridgeUnavailableError extends Error {
  public constructor() {
    super("desktop_bridge_unavailable");
    this.name = "DesktopBridgeUnavailableError";
  }
}

type LinkedAccountSnapshot = {
  email: string;
  name: string | null;
  verifiedAt: string;
};

type RemoteDesktopSession = {
  baseVersionNumber: number;
  downloadUrl: string;
  fileName: string;
  lastCheckpointAt: string | null;
  resumedFromCheckpoint: boolean;
  sessionId: string;
  sessionToken: string;
  tookOverExistingSession: boolean;
};

type OpenDocxInDesktopInput = {
  apiBaseUrl: string;
  entityId: string;
  linkedAccount: LinkedAccountSnapshot | null;
  propertyId: string;
  workspaceId: string;
} & ({ force?: never } | { force: true });

type BridgeResponse = {
  message?: string;
};

const isBridgeResponse = (value: unknown): value is BridgeResponse =>
  typeof value === "object" && value !== null;

const parseBridgeResponse = async (response: Response) => {
  try {
    const payload: unknown = await response.json();
    return isBridgeResponse(payload) ? payload : null;
  } catch {
    return null;
  }
};

const checkBridgeHealth = async (timeoutMs: number): Promise<boolean> => {
  try {
    const response = await fetch(`${DESKTOP_BRIDGE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const isMacOS = () => navigator.userAgent.includes("Mac");

/**
 * Try to launch the desktop app via the stella:// deep link (macOS only),
 * then poll the bridge health endpoint until it responds (or give up).
 */
const launchViaDeepLink = async (): Promise<boolean> => {
  if (!isMacOS()) {
    return false;
  }

  // Trigger the OS "open app" dialog
  window.location.href = "stella://ping";

  // Poll for up to ~6 seconds (the app needs time to start)
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    });
    if (await checkBridgeHealth(1000)) {
      return true;
    }
  }

  return false;
};

const assertDesktopBridgeReady = async () => {
  if (await checkBridgeHealth(3000)) {
    return;
  }

  // Bridge not reachable — try deep link launch (macOS only)
  if (await launchViaDeepLink()) {
    return;
  }

  throw new DesktopBridgeUnavailableError();
};

const openRemoteDesktopSession = async ({
  entityId,
  force,
  propertyId,
  workspaceId,
}: {
  entityId: string;
  force?: true | undefined;
  propertyId: string;
  workspaceId: string;
}) => {
  const response = await api
    .entities({ workspaceId })
    ["desktop-edit-sessions"].open.post({
      entityId,
      ...(force && { force }),
      propertyId,
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data satisfies RemoteDesktopSession;
};

/**
 * Check if the desktop bridge is reachable (app is running).
 * Returns true/false without throwing.
 */
export const isDesktopBridgeReachable = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${DESKTOP_BRIDGE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const openDocxInDesktop = async ({
  apiBaseUrl,
  entityId,
  force,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenDocxInDesktopInput) => {
  await assertDesktopBridgeReady();

  const remoteSession = await openRemoteDesktopSession({
    force,
    entityId,
    propertyId,
    workspaceId,
  });

  let response: Response;

  try {
    response = await fetch(`${DESKTOP_BRIDGE_URL}/v1/open-docx`, {
      body: JSON.stringify({
        apiBaseUrl,
        entityId,
        linkedAccount,
        propertyId,
        remoteSession,
        workspaceId,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DesktopBridgeUnavailableError();
  }

  if (!response.ok) {
    const payload = await parseBridgeResponse(response);
    if (payload?.message) {
      throw new Error(payload.message);
    }

    throw new DesktopBridgeUnavailableError();
  }

  return response;
};
