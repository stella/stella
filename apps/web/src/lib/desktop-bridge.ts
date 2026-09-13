import { panic, Result, TaggedError } from "better-result";

import type {
  DesktopAccountSnapshot,
  LinkAccountRequest,
  LinkedAccountSnapshot,
} from "@stll/api-contract/desktop-rpc";
import { FetchBoundaryError } from "@stll/errors";
import { Temporal } from "@stll/time";

import { env } from "@/env";
import { api } from "@/lib/api";
import { getFreshLinkedAccount } from "@/lib/auth-session";
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
const DESKTOP_ACCOUNT_LINK_CAPABILITY = "account-link.v2";
const DESKTOP_ACCOUNT_LINK_HASH = "#desktop-account";

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

export class DesktopAccountConflictError extends TaggedError(
  "DesktopAccountConflictError",
)<{ message: string }> {}

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
  account: LinkedAccountSnapshot;
  expiresAt: string;
  key: string;
};

type FreshLinkedAccount = NonNullable<
  Awaited<ReturnType<typeof getFreshLinkedAccount>>
>;

export const desktopAccountLinkRequest = (
  apiBaseUrl: string,
  grant: DesktopRegistryGrant,
) =>
  ({
    apiBaseUrl,
    credential: { expiresAt: grant.expiresAt, key: grant.key },
  }) satisfies LinkAccountRequest;

type CompleteDesktopAccountLinkOptions = {
  apiBaseUrl: string;
  grant: DesktopRegistryGrant;
  postLink: (
    body: ReturnType<typeof desktopAccountLinkRequest>,
  ) => Promise<Result<void, AccountLinkPostError>>;
  revoke: (key: string) => Promise<Result<void, unknown>>;
};

export type AccountLinkPostError =
  | { type: "ambiguous"; cause: unknown }
  | { type: "rejected"; cause: unknown };

export const completeDesktopAccountLink = async ({
  apiBaseUrl,
  grant,
  postLink,
  revoke,
}: CompleteDesktopAccountLinkOptions) => {
  const linked = await postLink(desktopAccountLinkRequest(apiBaseUrl, grant));
  if (linked.isOk()) {
    return Result.ok(grant.account.email);
  }
  if (linked.error.type === "ambiguous") {
    return Result.err(linked.error.cause);
  }
  const cleaned = await revoke(grant.key);
  if (cleaned.isErr()) {
    return Result.err(
      new AggregateError(
        [linked.error.cause, cleaned.error],
        "Desktop account link failed and credential cleanup failed",
        { cause: linked.error.cause },
      ),
    );
  }
  return Result.err(linked.error.cause);
};

export const isDesktopAccountLink = (hash: string) =>
  hash === DESKTOP_ACCOUNT_LINK_HASH;

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

const isDesktopAccountSnapshot = (
  value: unknown,
): value is DesktopAccountSnapshot => {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return false;
  }
  if (value.status === "disconnected") {
    return true;
  }
  return (
    value.status === "connected" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "string" &&
    "identity" in value &&
    typeof value.identity === "object" &&
    value.identity !== null &&
    "userId" in value.identity &&
    typeof value.identity.userId === "string" &&
    "organizationId" in value.identity &&
    typeof value.identity.organizationId === "string" &&
    "account" in value &&
    typeof value.account === "object" &&
    value.account !== null &&
    "email" in value.account &&
    typeof value.account.email === "string" &&
    "name" in value.account &&
    (typeof value.account.name === "string" || value.account.name === null) &&
    "verifiedAt" in value.account &&
    typeof value.account.verifiedAt === "string"
  );
};

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

  throw new FetchBoundaryError({
    message: "Desktop bridge rejected the command",
    status: response.status,
    statusText: response.statusText,
    url,
  });
};

const postAccountLinkOnce = async (
  body: ReturnType<typeof desktopAccountLinkRequest>,
) => {
  const result = await Result.tryPromise({
    try: async () => {
      await postBridgeCommand({ path: "/v1/link-account", body });
    },
    catch: (cause) => cause,
  });
  return result.mapError((cause) =>
    cause instanceof FetchBoundaryError && typeof cause.status === "number"
      ? ({ type: "rejected", cause } satisfies AccountLinkPostError)
      : ({ type: "ambiguous", cause } satisfies AccountLinkPostError),
  );
};

export const retryAmbiguousAccountLink = async (
  body: ReturnType<typeof desktopAccountLinkRequest>,
  postOnce: (
    request: ReturnType<typeof desktopAccountLinkRequest>,
  ) => Promise<Result<void, AccountLinkPostError>>,
) => {
  const first = await postOnce(body);
  if (first.isOk() || first.error.type === "rejected") {
    return first;
  }
  const retry = await postOnce(body);
  if (retry.isOk()) {
    return retry;
  }
  return Result.err({
    type: "ambiguous",
    cause: retry.error.cause,
  } satisfies AccountLinkPostError);
};

const readDesktopAccount = async (apiBaseUrl: string) => {
  const query = new URLSearchParams({ apiBaseUrl });
  const url = `${DESKTOP_BRIDGE_URL}/v1/account?${query.toString()}`;
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(
        url,
        loopback({ method: "GET", timeoutMs: 10_000 }),
      ),
    catch: () => new DesktopBridgeUnavailableError(),
  });
  if (fetched.isErr()) {
    return fetched;
  }
  const response = fetched.value;
  if (!response.ok) {
    const payload = await parseBridgeResponse(response);
    return Result.err(
      new FetchBoundaryError({
        message: payload?.message ?? "Desktop account state unavailable",
        status: response.status,
        statusText: response.statusText,
        url,
      }),
    );
  }
  const parsed = await Result.tryPromise({
    try: async () => {
      const payload: unknown = await response.json();
      return payload;
    },
    catch: () => new DesktopBridgeIncompatibleError(),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const payload = parsed.value;
  if (!isDesktopAccountSnapshot(payload)) {
    return Result.err(new DesktopBridgeIncompatibleError());
  }
  return Result.ok(payload);
};

type ResolveDesktopAccountLinkOptions = {
  apiBaseUrl: string;
  browserAccount: FreshLinkedAccount;
  desktopAccount: DesktopAccountSnapshot;
  mintGrant: () => Promise<DesktopRegistryGrant>;
  postLink: CompleteDesktopAccountLinkOptions["postLink"];
  revoke: CompleteDesktopAccountLinkOptions["revoke"];
};

export const resolveDesktopAccountLink = async ({
  apiBaseUrl,
  browserAccount,
  desktopAccount,
  mintGrant,
  postLink,
  revoke,
}: ResolveDesktopAccountLinkOptions) => {
  switch (desktopAccount.status) {
    case "connected":
      if (
        desktopAccount.identity.userId !== browserAccount.identity.userId ||
        desktopAccount.identity.organizationId !==
          browserAccount.identity.organizationId
      ) {
        return Result.err(
          new DesktopAccountConflictError({
            message: "desktop_account_conflict",
          }),
        );
      }
      return Result.ok(desktopAccount.account.email);
    case "disconnected": {
      const minted = await Result.tryPromise({
        try: mintGrant,
        catch: (cause) => cause,
      });
      if (minted.isErr()) {
        return minted;
      }
      return await completeDesktopAccountLink({
        apiBaseUrl,
        grant: minted.value,
        postLink,
        revoke,
      });
    }
    default:
      desktopAccount satisfies never;
      return panic("Unknown desktop account state");
  }
};

export const linkDesktopAccount = async ({
  apiBaseUrl,
}: Pick<LinkAccountRequest, "apiBaseUrl">) => {
  const compatible = await Result.tryPromise({
    try: async () =>
      await requireCompatibleBridge({
        requiredCapability: DESKTOP_ACCOUNT_LINK_CAPABILITY,
        signalUpdateCheck: true,
        readHealth: async () =>
          (await readBridgeHealth(500)) ??
          (await wakeDesktopAndReadBridgeHealth()),
      }),
    catch: (cause) => cause,
  });
  if (compatible.isErr()) {
    return compatible;
  }
  const [desktopAccount, browserAccountResult] = await Promise.all([
    readDesktopAccount(apiBaseUrl),
    Result.tryPromise({
      try: getFreshLinkedAccount,
      catch: (cause) => cause,
    }),
  ]);
  if (desktopAccount.isErr()) {
    return desktopAccount;
  }
  if (browserAccountResult.isErr()) {
    return browserAccountResult;
  }
  if (!browserAccountResult.value) {
    return Result.err(
      new DesktopAccountConflictError({ message: "desktop_account_conflict" }),
    );
  }
  return await resolveDesktopAccountLink({
    apiBaseUrl,
    browserAccount: browserAccountResult.value,
    desktopAccount: desktopAccount.value,
    // Mint only after the compatible bridge answers and confirms that no live
    // account is linked, so retries cannot create unused credentials.
    mintGrant: async () =>
      unwrapEden(
        await api["desktop-registry"].grant.post({}),
      ) satisfies DesktopRegistryGrant,
    postLink: async (body) =>
      await retryAmbiguousAccountLink(body, postAccountLinkOnce),
    revoke: async (key) => await revokeDesktopCredential({ apiBaseUrl, key }),
  });
};

type RevokeDesktopCredentialOptions = {
  apiBaseUrl: string;
  key: string;
};

// Transport failures are returned, not thrown: the caller pairs them with the
// link failure that made cleanup necessary. A 401 means the credential is
// already unusable, which is the outcome cleanup wants.
export const revokeDesktopCredential = async ({
  apiBaseUrl,
  key,
}: RevokeDesktopCredentialOptions): Promise<Result<void, unknown>> => {
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(`${apiBaseUrl}/v1/desktop-registry/request`, {
        body: JSON.stringify({ type: "revoke" }),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        timeoutMs: 10_000,
      }),
    catch: (cause) => cause,
  });
  if (fetched.isErr()) {
    return fetched;
  }
  const response = fetched.value;
  if (!response.ok && response.status !== 401) {
    return Result.err(
      new FetchBoundaryError({
        message: "Desktop account credential cleanup failed",
        status: response.status,
        statusText: response.statusText,
        url: response.url,
      }),
    );
  }
  return Result.ok(undefined);
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
