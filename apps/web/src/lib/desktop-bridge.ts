import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

const DESKTOP_BRIDGE_PORT = 45_901;
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
};

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

const assertDesktopBridgeReady = async () => {
  let response: Response;

  try {
    response = await fetch(`${DESKTOP_BRIDGE_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new DesktopBridgeUnavailableError();
  }

  if (!response.ok) {
    throw new DesktopBridgeUnavailableError();
  }
};

const openRemoteDesktopSession = async ({
  entityId,
  propertyId,
  workspaceId,
}: Pick<OpenDocxInDesktopInput, "entityId" | "propertyId" | "workspaceId">) => {
  const response = await api
    .entities({ workspaceId })
    ["desktop-edit-sessions"].open.post({
      entityId,
      propertyId,
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data satisfies RemoteDesktopSession;
};

export const openDocxInDesktop = async ({
  apiBaseUrl,
  entityId,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenDocxInDesktopInput) => {
  await assertDesktopBridgeReady();

  const remoteSession = await openRemoteDesktopSession({
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
