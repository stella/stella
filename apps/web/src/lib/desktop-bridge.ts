import { panic, Result, TaggedError } from "better-result";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type {
  DesktopAccountIdentity,
  LinkAccountRequest,
  LinkedAccountSnapshot,
} from "@stll/api-contract/desktop-rpc";
import { FetchBoundaryError } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import type { FetchWithTimeoutInit } from "@stll/fetch";
import { Temporal } from "@stll/time";

import { env } from "@/env";
import type { DesktopLinkOutcome } from "@/features/desktop/desktop-connection-store.logic";
import {
  DESKTOP_HANDOFF_POLL_INTERVAL_MS,
  watchDesktopEditHandoff,
} from "@/features/desktop/desktop-edit-handoff";
import { api } from "@/lib/api";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { unwrapEden } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { toSafeId } from "@/lib/safe-id";

const DESKTOP_BRIDGE_PORT = env.VITE_DESKTOP_BRIDGE_PORT;
const DESKTOP_BRIDGE_URL = `http://127.0.0.1:${String(DESKTOP_BRIDGE_PORT)}`;
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

type DesktopEditHandoff = {
  deepLinkUrl: string;
  expiresAt: string;
  handoffId: string;
};

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

const DESKTOP_ACCOUNT_CHALLENGE_TTL_MS = 60_000;

type DesktopAccountChallenge = {
  correlationId: string;
  verifierHash: string;
  portSecret: string;
  protocol: string;
};

type DesktopAccountAttempt =
  | {
      type: "challenge";
      challenge: DesktopAccountChallenge & { expiresAt: number };
    }
  | { type: "update-required" };
let accountAttempt: DesktopAccountAttempt | null = null;

export const parseDesktopAccountChallenge = (hash: string) => {
  if (!hash.startsWith(`${DESKTOP_ACCOUNT_LINK_HASH}?`)) {
    return null;
  }
  const params = new URLSearchParams(
    hash.slice(DESKTOP_ACCOUNT_LINK_HASH.length + 1),
  );
  const correlationId = params.get("correlationId");
  const verifierHash = params.get("verifierHash");
  const portSecret = params.get("portSecret");
  const protocol = params.get("protocol");
  if (
    [...params].length !== 4 ||
    protocol !== String(DESKTOP_ACCOUNT_POLICY.linkProtocol) ||
    !correlationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      correlationId,
    ) ||
    !verifierHash ||
    !/^[0-9a-f]{64}$/u.test(verifierHash) ||
    !portSecret ||
    !/^[0-9a-f]{64}$/u.test(portSecret)
  ) {
    return null;
  }
  return { correlationId, verifierHash, portSecret, protocol };
};

export const captureDesktopAccountLink = () => {
  const hash = window.location.hash;
  if (!hash.startsWith(`${DESKTOP_ACCOUNT_LINK_HASH}?`)) {
    return false;
  }
  const challenge = parseDesktopAccountChallenge(hash);
  if (!challenge) {
    accountAttempt = { type: "update-required" };
  } else {
    accountAttempt = {
      type: "challenge",
      challenge: {
        ...challenge,
        expiresAt:
          Temporal.Now.instant().epochMilliseconds +
          DESKTOP_ACCOUNT_CHALLENGE_TTL_MS,
      },
    };
  }
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return true;
};

type DesktopBridgeProofOptions = {
  portSecret: string;
  timestamp: string;
  path: string;
};

export const desktopBridgeProofHeaders = async ({
  portSecret,
  timestamp,
  path,
}: DesktopBridgeProofOptions) => {
  const bytes = new TextEncoder().encode(portSecret);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}\nGET\n${path}`),
  );
  const proof = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { "x-stella-bridge-time": timestamp, "x-stella-bridge-proof": proof };
};

const isBridgeResponse = (value: unknown): value is BridgeResponse =>
  typeof value === "object" && value !== null;

const parseDesktopConnectionStatus = (value: unknown) => {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return null;
  }
  switch (value.status) {
    case "pending":
    case "connected":
    case "failed":
      return value.status;
    default:
      return null;
  }
};

const DESKTOP_BRIDGE_RESPONSE_MAX_SKEW_SECONDS = 30;

type VerifyDesktopConnectionOptions = {
  payload: unknown;
  correlationId: string;
  portSecret: string;
  nowSeconds: number;
};

export const verifyDesktopConnectionStatus = async ({
  payload,
  correlationId,
  portSecret,
  nowSeconds,
}: VerifyDesktopConnectionOptions) => {
  const status = parseDesktopConnectionStatus(payload);
  if (
    status === null ||
    typeof payload !== "object" ||
    payload === null ||
    !("correlationId" in payload) ||
    payload.correlationId !== correlationId ||
    !("timestamp" in payload) ||
    typeof payload.timestamp !== "string" ||
    !/^[0-9]{1,16}$/u.test(payload.timestamp) ||
    !("proof" in payload) ||
    typeof payload.proof !== "string" ||
    !/^[0-9a-f]{64}$/u.test(payload.proof)
  ) {
    return null;
  }
  const timestamp = Number(payload.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > DESKTOP_BRIDGE_RESPONSE_MAX_SKEW_SECONDS
  ) {
    return null;
  }
  const proof = payload.proof;
  const signature = Uint8Array.from({ length: 32 }, (_, offset) =>
    Number.parseInt(proof.slice(offset * 2, offset * 2 + 2), 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(portSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(
      `${correlationId}\n${status}\n${payload.timestamp}`,
    ),
  );
  return valid ? status : null;
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

  return unwrapEden(response);
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
  const outcome = readQueryResult(
    await watchDesktopEditHandoff({
      expiresAt,
      readStatus: async () =>
        await readDesktopEditHandoffStatus({ handoffId, workspaceId }),
    }),
  );
  if (outcome === "opened") {
    return;
  }

  throw new DesktopBridgeUnavailableError();
};

const readDesktopConnection = async (
  correlationId: string,
  portSecret: string,
) => {
  const query = new URLSearchParams({ correlationId });
  const path = `/v1/connection?${query.toString()}`;
  const url = `${DESKTOP_BRIDGE_URL}${path}`;
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(
        url,
        loopback({
          method: "GET",
          timeoutMs: 1000,
          headers: await desktopBridgeProofHeaders({
            portSecret,
            timestamp: String(
              Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
            ),
            path,
          }),
        }),
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
  const verified = await Result.tryPromise({
    try: async () =>
      await verifyDesktopConnectionStatus({
        payload: parsed.value,
        correlationId,
        portSecret,
        nowSeconds: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
      }),
    catch: () => new DesktopBridgeIncompatibleError(),
  });
  if (verified.isErr()) {
    return verified;
  }
  const payload = verified.value;
  if (payload === null) {
    return Result.err(new DesktopBridgeIncompatibleError());
  }
  return Result.ok(payload);
};

type ResolveDesktopAccountLinkOptions = {
  browserAccount: NonNullable<
    Awaited<ReturnType<typeof getFreshLinkedAccount>>
  >;
  linkedIdentity: DesktopAccountIdentity;
};

export const resolveDesktopAccountLink = ({
  browserAccount,
  linkedIdentity,
}: ResolveDesktopAccountLinkOptions) => {
  if (
    linkedIdentity.userId !== browserAccount.identity.userId ||
    linkedIdentity.organizationId !== browserAccount.identity.organizationId
  ) {
    return Result.err(
      new DesktopAccountConflictError({ message: "desktop_account_conflict" }),
    );
  }
  return Result.ok(browserAccount.email);
};

export const linkDesktopAccount = async ({
  apiBaseUrl,
}: Pick<LinkAccountRequest, "apiBaseUrl">) => {
  captureDesktopAccountLink();
  const attempt = accountAttempt;
  accountAttempt = null;
  if (attempt?.type === "update-required") {
    return Result.ok({
      status: "update-required",
    } as const satisfies DesktopLinkOutcome);
  }
  const challenge = attempt?.challenge;
  if (
    !challenge ||
    challenge.expiresAt <= Temporal.Now.instant().epochMilliseconds
  ) {
    const params = new URLSearchParams({
      apiBaseUrl,
      webOrigin: window.location.origin,
    });
    window.location.href = `stella://account/connect?${params.toString()}`;
    return Result.ok({
      status: "started",
    } as const satisfies DesktopLinkOutcome);
  }
  return await Result.tryPromise({
    try: async () => {
      const browserAccount = await getFreshLinkedAccount();
      if (!browserAccount) {
        throw new DesktopAccountConflictError({
          message: "desktop_account_conflict",
        });
      }
      const grant = unwrapEden(
        await api["desktop-registry"].grant.post({
          correlationId: challenge.correlationId,
          verifierHash: challenge.verifierHash,
        }),
      );
      const matched = resolveDesktopAccountLink({
        browserAccount,
        linkedIdentity: grant,
      });
      if (matched.isErr()) {
        throw matched.error;
      }
      const params = new URLSearchParams({
        correlationId: challenge.correlationId,
        userId: grant.userId,
        organizationId: grant.organizationId,
      });
      window.location.href = `stella://account/complete?${params.toString()}`;
      const deadline = Math.min(
        challenge.expiresAt,
        new Date(grant.expiresAt).getTime(),
      );
      while (Temporal.Now.instant().epochMilliseconds < deadline) {
        const connection = await readDesktopConnection(
          challenge.correlationId,
          challenge.portSecret,
        );
        if (connection.isOk()) {
          const status = connection.value;
          switch (status) {
            case "connected":
              return {
                status: "connected",
                email: matched.value,
              } as const satisfies DesktopLinkOutcome;
            case "failed":
              throw new DesktopBridgeUnavailableError();
            case "pending":
              break;
            default:
              status satisfies never;
              return panic("Unknown desktop connection status");
          }
        }
        if (
          connection.isErr() &&
          !(connection.error instanceof DesktopBridgeUnavailableError)
        ) {
          throw connection.error;
        }
        await wait(DESKTOP_HANDOFF_POLL_INTERVAL_MS);
      }
      throw new DesktopBridgeUnavailableError();
    },
    catch: (cause) => cause,
  });
};

export const openFileInDesktop = async (input: OpenFileInDesktopInput) => {
  const handoff = await createDesktopEditHandoff(input);
  launchDesktopEditHandoff(handoff.deepLinkUrl);
  return {
    type: "handoff-pending",
    waitUntilOpened: waitForDesktopEditHandoffOpened({
      expiresAt: handoff.expiresAt,
      handoffId: handoff.handoffId,
      workspaceId: input.workspaceId,
    }),
  } satisfies OpenFileInDesktopResult;
};
