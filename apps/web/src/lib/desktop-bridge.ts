import type { LinkAccountRequest } from "@stll/api-contract/desktop-rpc";
import { FetchBoundaryError } from "@stll/errors";
import { Temporal } from "@stll/time";

import { env } from "@/env";
import { api } from "@/lib/api";
import type { DesktopEditFileType } from "@/lib/desktop-edit-formats";
import { buildSelfHostConnectDeepLink } from "@/lib/desktop-self-host-link.logic";
import { unwrapEden } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";
import type { FetchWithTimeoutInit } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";

const DESKTOP_BRIDGE_PORT = env.VITE_DESKTOP_BRIDGE_PORT;
const DESKTOP_BRIDGE_URL = `http://127.0.0.1:${String(DESKTOP_BRIDGE_PORT)}`;
const DESKTOP_HANDOFF_POLL_INTERVAL_MS = 750;
const DESKTOP_BRIDGE_START_POLL_INTERVAL_MS = 1000;
const DESKTOP_BRIDGE_START_TIMEOUT_MS = 6000;
const DESKTOP_SELF_HOST_CONNECT_POLL_INTERVAL_MS = 750;
const DESKTOP_SELF_HOST_CONNECT_TIMEOUT_MS = 120_000;
const MIN_DESKTOP_BRIDGE_VERSION = 9;
const REQUIRED_DESKTOP_BRIDGE_CAPABILITY = "office-edit.v1";
const DESKTOP_ACCOUNT_LINK_CAPABILITY = "account-link.v1";
const DESKTOP_REGISTRY_HASH_PREFIX = "#desktop-registry=";
const DESKTOP_REGISTRY_NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DESKTOP_REGISTRY_CAPABILITY = "registry-search.v1";

export class DesktopBridgeUnavailableError extends Error {
  public constructor() {
    super("desktop_bridge_unavailable");
    this.name = "DesktopBridgeUnavailableError";
  }
}

export class DesktopBridgeIncompatibleError extends Error {
  public constructor() {
    super("desktop_bridge_incompatible");
    this.name = "DesktopBridgeIncompatibleError";
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
  fileType: DesktopEditFileType;
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

export type OpenFileInDesktopResult =
  | { type: "opened" }
  | { type: "handoff-pending"; waitUntilOpened: Promise<void> };

type OpenFileInDesktopInput = {
  apiBaseUrl: string;
  entityId: string;
  linkedAccount: LinkedAccountSnapshot | null;
  propertyId: string;
  workspaceId: string;
} & ({ force?: never } | { force: true });

type BridgeResponse = {
  message?: string;
};

type BridgeHealth = {
  capabilities?: string[];
  bridgeVersion?: number;
};

type SelfHostConnectionStatus = {
  trusted: boolean;
};

type DesktopRegistryGrant = {
  expiresAt: string;
  key: string;
};

type DesktopRegistryConnectInput = {
  apiBaseUrl: string;
  nonce: string;
};

export const readDesktopRegistryNonce = (hash: string): string | null => {
  if (!hash.startsWith(DESKTOP_REGISTRY_HASH_PREFIX)) {
    return null;
  }

  const nonce = hash.slice(DESKTOP_REGISTRY_HASH_PREFIX.length);
  return DESKTOP_REGISTRY_NONCE_PATTERN.test(nonce) ? nonce : null;
};

const isBridgeResponse = (value: unknown): value is BridgeResponse =>
  typeof value === "object" && value !== null;

const isBridgeHealth = (value: unknown): value is BridgeHealth =>
  typeof value === "object" &&
  value !== null &&
  (!("bridgeVersion" in value) || typeof value.bridgeVersion === "number") &&
  (!("capabilities" in value) ||
    (Array.isArray(value.capabilities) &&
      value.capabilities.every(
        (capability) => typeof capability === "string",
      )));

const isSelfHostConnectionStatus = (
  value: unknown,
): value is SelfHostConnectionStatus =>
  typeof value === "object" &&
  value !== null &&
  "trusted" in value &&
  typeof value.trusted === "boolean";

/**
 * Every call here targets the app's loopback listener. Chromium's Local
 * Network Access check reads this hint on the request: declaring the target
 * address space keeps the request classified (and any permission prompt named)
 * as loopback instead of being judged as a private-network access. Engines
 * that do not implement it ignore the field.
 */
type LoopbackFetchInit = FetchWithTimeoutInit & {
  targetAddressSpace: "loopback";
};

const loopback = (init: FetchWithTimeoutInit): LoopbackFetchInit => ({
  ...init,
  targetAddressSpace: "loopback",
});

const parseBridgeResponse = async (response: Response) => {
  try {
    const payload: unknown = await response.json();
    return isBridgeResponse(payload) ? payload : null;
  } catch {
    return null;
  }
};

const readBridgeHealth = async (
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BridgeHealth | null> => {
  try {
    const response = await fetchWithTimeout(
      `${DESKTOP_BRIDGE_URL}/health`,
      loopback({
        method: "GET",
        ...(signal && { signal }),
        timeoutMs,
      }),
    );
    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    return isBridgeHealth(payload) ? payload : {};
  } catch {
    return null;
  }
};

const isCompatibleDesktopBridge = (
  health: BridgeHealth,
  requiredCapability: string,
) =>
  typeof health.bridgeVersion === "number" &&
  health.bridgeVersion >= MIN_DESKTOP_BRIDGE_VERSION &&
  health.capabilities?.includes(requiredCapability) === true;

const signalDesktopUpdateCheck = () => {
  window.location.href = "stella://ping";
};

const assertCompatibleDesktopBridge = (
  health: BridgeHealth,
  {
    requiredCapability = REQUIRED_DESKTOP_BRIDGE_CAPABILITY,
    signalUpdateCheck = true,
  }: {
    requiredCapability?: string;
    signalUpdateCheck?: boolean;
  } = {},
) => {
  if (isCompatibleDesktopBridge(health, requiredCapability)) {
    return;
  }

  if (signalUpdateCheck) {
    signalDesktopUpdateCheck();
  }

  throw new DesktopBridgeIncompatibleError();
};

const wakeDesktopAndReadBridgeHealth =
  async (): Promise<BridgeHealth | null> => {
    signalDesktopUpdateCheck();

    const deadline =
      Temporal.Now.instant().epochMilliseconds +
      DESKTOP_BRIDGE_START_TIMEOUT_MS;
    while (Temporal.Now.instant().epochMilliseconds < deadline) {
      await wait(
        Math.min(
          DESKTOP_BRIDGE_START_POLL_INTERVAL_MS,
          deadline - Temporal.Now.instant().epochMilliseconds,
        ),
      );

      const health = await readBridgeHealth(1000);
      if (health) {
        return health;
      }
    }

    return null;
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

  return unwrapEden(response) satisfies RemoteDesktopSession;
};

const createDesktopEditHandoff = async ({
  entityId,
  force,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenFileInDesktopInput) => {
  const response = await api
    .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
    ["desktop-edit-handoffs"].post({
      entityId: toSafeId<"entity">(entityId),
      ...(force && { force }),
      linkedAccount,
      propertyId: toSafeId<"property">(propertyId),
    });

  return unwrapEden(response) satisfies DesktopEditHandoff;
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

  return unwrapEden(response) satisfies DesktopEditHandoffStatus;
};

const launchDesktopEditHandoff = (deepLinkUrl: string) => {
  window.location.href = deepLinkUrl;
};

const launchSelfHostConnect = ({
  apiBaseUrl,
  webOrigin,
}: {
  apiBaseUrl: string;
  webOrigin: string;
}) => {
  window.location.href = buildSelfHostConnectDeepLink({
    apiBaseUrl,
    webOrigin,
  });
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
  const parsedDeadline = new Date(expiresAt).getTime();
  let deadline = Number.isFinite(parsedDeadline)
    ? parsedDeadline
    : Temporal.Now.instant().epochMilliseconds + 30_000;

  while (Temporal.Now.instant().epochMilliseconds < deadline) {
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

    const nextDeadline = new Date(handoffStatus.expiresAt).getTime();
    if (Number.isFinite(nextDeadline) && nextDeadline > deadline) {
      deadline = nextDeadline;
    }

    await wait(
      Math.max(
        0,
        Math.min(
          DESKTOP_HANDOFF_POLL_INTERVAL_MS,
          deadline - Temporal.Now.instant().epochMilliseconds,
        ),
      ),
    );
  }

  throw new DesktopBridgeUnavailableError();
};

/**
 * Whether a running desktop app can link an account right now. Answers false
 * rather than throwing, and also for an app too old to link: a watch then keeps
 * polling instead of ending on a bridge that would refuse the link anyway.
 */
export const isDesktopAccountLinkReachable = async (
  signal?: AbortSignal,
): Promise<boolean> => {
  const health = await readBridgeHealth(500, signal);
  return (
    health !== null &&
    isCompatibleDesktopBridge(health, DESKTOP_ACCOUNT_LINK_CAPABILITY)
  );
};

const readSelfHostedDesktopConnection = async ({
  apiBaseUrl,
}: {
  apiBaseUrl: string;
}): Promise<SelfHostConnectionStatus | null> => {
  const params = new URLSearchParams({ apiBaseUrl });

  try {
    const response = await fetchWithTimeout(
      `${DESKTOP_BRIDGE_URL}/v1/self-host-connection?${params.toString()}`,
      loopback({
        method: "GET",
        timeoutMs: 1000,
      }),
    );
    if (!response.ok) {
      return null;
    }

    const payload: unknown = await response.json();
    return isSelfHostConnectionStatus(payload) ? payload : null;
  } catch {
    return null;
  }
};

export const connectSelfHostedDesktop = async ({
  apiBaseUrl,
  webOrigin,
}: {
  apiBaseUrl: string;
  webOrigin: string;
}) => {
  launchSelfHostConnect({ apiBaseUrl, webOrigin });

  const deadline =
    Temporal.Now.instant().epochMilliseconds +
    DESKTOP_SELF_HOST_CONNECT_TIMEOUT_MS;
  while (Temporal.Now.instant().epochMilliseconds < deadline) {
    const status = await readSelfHostedDesktopConnection({ apiBaseUrl });
    if (status?.trusted) {
      return;
    }

    await wait(
      Math.max(
        0,
        Math.min(
          DESKTOP_SELF_HOST_CONNECT_POLL_INTERVAL_MS,
          deadline - Temporal.Now.instant().epochMilliseconds,
        ),
      ),
    );
  }

  throw new DesktopBridgeUnavailableError();
};

type BridgeRequirement = {
  requiredCapability: string;
  signalUpdateCheck: boolean;
  readHealth: () => Promise<BridgeHealth | null>;
};

const requireCompatibleBridge = async ({
  requiredCapability,
  signalUpdateCheck,
  readHealth,
}: BridgeRequirement) => {
  const health = await readHealth();
  if (!health) {
    throw new DesktopBridgeUnavailableError();
  }
  assertCompatibleDesktopBridge(health, {
    requiredCapability,
    signalUpdateCheck,
  });
};

type BridgeCommand = {
  path: string;
  body: unknown;
};

// One failure boundary for every POST that drives the desktop bridge: an
// unreachable bridge and a rejected command surface through the same errors
// regardless of the command.
const postBridgeCommand = async ({ path, body }: BridgeCommand) => {
  const url = `${DESKTOP_BRIDGE_URL}${path}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      loopback({
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: 10_000,
      }),
    );
  } catch {
    throw new DesktopBridgeUnavailableError();
  }

  if (response.ok) {
    return;
  }

  const payload = await parseBridgeResponse(response);
  if (payload?.message) {
    throw new FetchBoundaryError({
      message: payload.message,
      status: response.status,
      statusText: response.statusText,
      url,
    });
  }

  throw new DesktopBridgeUnavailableError();
};

export const linkDesktopAccount = async (request: LinkAccountRequest) => {
  await requireCompatibleBridge({
    requiredCapability: DESKTOP_ACCOUNT_LINK_CAPABILITY,
    signalUpdateCheck: true,
    readHealth: async () =>
      (await readBridgeHealth(500)) ?? (await wakeDesktopAndReadBridgeHealth()),
  });
  await postBridgeCommand({ path: "/v1/link-account", body: request });
};

// The grant is minted only once the bridge is known to accept it, so an
// absent desktop never leaves an unused credential behind.
export const connectDesktopRegistry = async ({
  apiBaseUrl,
  nonce,
}: DesktopRegistryConnectInput) => {
  await requireCompatibleBridge({
    requiredCapability: DESKTOP_REGISTRY_CAPABILITY,
    signalUpdateCheck: false,
    readHealth: async () => await readBridgeHealth(500),
  });
  const grant = unwrapEden(
    await api["desktop-registry"].grant.post({}),
  ) satisfies DesktopRegistryGrant;
  await postBridgeCommand({
    path: "/v1/registry-connect",
    body: {
      apiBaseUrl,
      expiresAt: grant.expiresAt,
      key: grant.key,
      nonce,
    },
  });
};

const openFileViaBridge = async ({
  apiBaseUrl,
  entityId,
  force,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenFileInDesktopInput) => {
  const remoteSession = await openRemoteDesktopSession({
    force,
    entityId,
    propertyId,
    workspaceId,
  });

  let response: Response;

  try {
    response = await fetchWithTimeout(
      `${DESKTOP_BRIDGE_URL}/v1/open-file`,
      loopback({
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
        timeoutMs: 10_000,
      }),
    );
  } catch {
    return await rethrowAfterBridgeCompatibilityCheck(
      new DesktopBridgeUnavailableError(),
    );
  }

  if (!response.ok) {
    const payload = await parseBridgeResponse(response);
    if (payload?.message) {
      return await rethrowAfterBridgeCompatibilityCheck(
        new FetchBoundaryError({
          url: `${DESKTOP_BRIDGE_URL}/v1/open-file`,
          status: response.status,
          statusText: response.statusText,
          message: payload.message,
        }),
      );
    }

    return await rethrowAfterBridgeCompatibilityCheck(
      new DesktopBridgeUnavailableError(),
    );
  }

  return { type: "opened" } satisfies OpenFileInDesktopResult;
};

const rethrowAfterBridgeCompatibilityCheck = async (
  error: unknown,
): Promise<never> => {
  const health = await readBridgeHealth(500);
  if (health) {
    assertCompatibleDesktopBridge(health);
  }

  throw error;
};

export const openFileInDesktop = async ({
  apiBaseUrl,
  entityId,
  force,
  linkedAccount,
  propertyId,
  workspaceId,
}: OpenFileInDesktopInput) => {
  const bridgeHealth = await readBridgeHealth(500);
  if (bridgeHealth) {
    assertCompatibleDesktopBridge(bridgeHealth);

    return await openFileViaBridge({
      apiBaseUrl,
      entityId,
      linkedAccount,
      propertyId,
      workspaceId,
      ...(force && { force }),
    });
  }

  const awakenedBridgeHealth = await wakeDesktopAndReadBridgeHealth();
  if (awakenedBridgeHealth) {
    assertCompatibleDesktopBridge(awakenedBridgeHealth, {
      signalUpdateCheck: false,
    });

    return await openFileViaBridge({
      apiBaseUrl,
      entityId,
      linkedAccount,
      propertyId,
      workspaceId,
      ...(force && { force }),
    });
  }

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
    }).catch(rethrowAfterBridgeCompatibilityCheck),
  } satisfies OpenFileInDesktopResult;
};
