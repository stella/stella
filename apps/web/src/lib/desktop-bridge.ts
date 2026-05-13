import { env } from "@/env";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";

const DESKTOP_BRIDGE_PORT = env.VITE_DESKTOP_BRIDGE_PORT;
const DESKTOP_BRIDGE_URL = `http://127.0.0.1:${String(DESKTOP_BRIDGE_PORT)}`;
const DESKTOP_HANDOFF_POLL_INTERVAL_MS = 750;

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

type DesktopEditHandoff = {
  deepLinkUrl: string;
  expiresAt: string;
  handoffId: string;
};

type DesktopEditHandoffStatus =
  | { status: "expired"; expiresAt: string }
  | { status: "opened"; sessionId: string }
  | { status: "pending"; expiresAt: string };

export type OpenDocxInDesktopResult =
  | { type: "opened" }
  | { type: "handoff-pending"; waitUntilOpened: Promise<void> };

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

const assertDesktopBridgeReady = async () => {
  if (await checkBridgeHealth(3000)) {
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
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["desktop-edit-sessions"].open.post({
      entityId: toSafeId<"entity">(entityId),
      ...(force && { force }),
      propertyId: toSafeId<"property">(propertyId),
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data satisfies RemoteDesktopSession;
};

const createDesktopEditHandoff = async ({
  entityId,
  force,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenDocxInDesktopInput) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["desktop-edit-handoffs"].post({
      entityId: toSafeId<"entity">(entityId),
      ...(force && { force }),
      linkedAccount,
      propertyId: toSafeId<"property">(propertyId),
    });

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data satisfies DesktopEditHandoff;
};

const readDesktopEditHandoffStatus = async ({
  handoffId,
  workspaceId,
}: {
  handoffId: string;
  workspaceId: string;
}) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["desktop-edit-handoffs"]({
      handoffId: toSafeId<"desktopEditHandoff">(handoffId),
    })
    .status.get();

  if (response.error) {
    throw toAPIError(response.error);
  }

  return response.data satisfies DesktopEditHandoffStatus;
};

const launchDesktopEditHandoff = (deepLinkUrl: string) => {
  window.location.href = deepLinkUrl;
};

const wait = async (milliseconds: number) => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const waitForDesktopEditHandoffOpened = async ({
  expiresAt,
  handoffId,
  workspaceId,
}: {
  expiresAt: string;
  handoffId: string;
  workspaceId: string;
}) => {
  const parsedDeadline = Date.parse(expiresAt);
  const deadline = Number.isFinite(parsedDeadline)
    ? parsedDeadline
    : Date.now() + 30_000;

  while (Date.now() < deadline) {
    const handoffStatus = await readDesktopEditHandoffStatus({
      handoffId,
      workspaceId,
    });

    if (handoffStatus.status === "opened") {
      return;
    }

    if (handoffStatus.status === "expired") {
      break;
    }

    await wait(
      Math.max(
        0,
        Math.min(DESKTOP_HANDOFF_POLL_INTERVAL_MS, deadline - Date.now()),
      ),
    );
  }

  throw new DesktopBridgeUnavailableError();
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
  if (!(await checkBridgeHealth(500))) {
    const handoff = await createDesktopEditHandoff({
      apiBaseUrl,
      entityId,
      linkedAccount,
      propertyId,
      workspaceId,
      ...(force && { force }),
    });
    launchDesktopEditHandoff(handoff.deepLinkUrl);
    return {
      type: "handoff-pending",
      waitUntilOpened: waitForDesktopEditHandoffOpened({
        expiresAt: handoff.expiresAt,
        handoffId: handoff.handoffId,
        workspaceId,
      }),
    } satisfies OpenDocxInDesktopResult;
  }

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

  return { type: "opened" } satisfies OpenDocxInDesktopResult;
};
