import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type {
  DesktopAccountIdentity,
  LinkAccountRequest,
  LinkedAccountSnapshot,
} from "@stll/api-contract/desktop-rpc";
import { sleep } from "@stll/concurrency/sleep";
import { FetchBoundaryError } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import type { FetchWithTimeoutInit } from "@stll/fetch";
import { Temporal } from "@stll/time";

import { env } from "@/env";
import type {
  DesktopLinkApproval,
  DesktopLinkOutcome,
} from "@/features/desktop/desktop-connection-store.logic";
import {
  DESKTOP_HANDOFF_POLL_INTERVAL_MS,
  watchDesktopEditHandoff,
} from "@/features/desktop/desktop-edit-handoff";
import { browserStateStorage } from "@/lib/account/browser-storage";
import { api } from "@/lib/api";
import { getFreshLinkedAccount } from "@/lib/auth-session";
import { unwrapApiResponse } from "@/lib/errors/api";
import { readQueryResult } from "@/lib/errors/query-result";
import { toSafeId } from "@/lib/safe-id";
import { readStoredJson, serializeStoredJson } from "@/lib/stored-json";

const DESKTOP_BRIDGE_PORT = env.VITE_DESKTOP_BRIDGE_PORT;
const DESKTOP_BRIDGE_URL = `http://127.0.0.1:${String(DESKTOP_BRIDGE_PORT)}`;
const DESKTOP_ACCOUNT_LINK_HASH = "#desktop-account";

class DesktopBridgeUnavailableError extends Error {
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
  deviceJkt: string;
  portSecret: string;
  protocol: string;
};

export const desktopAccountGrantRequest = (
  challenge: DesktopAccountChallenge,
) => ({
  correlationId: challenge.correlationId,
  verifierHash: challenge.verifierHash,
  deviceJkt: challenge.deviceJkt,
});

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
  const deviceJkt = params.get("deviceJkt");
  const protocol = params.get("protocol");
  if (
    [...params].length !== 5 ||
    protocol !== String(DESKTOP_ACCOUNT_POLICY.linkProtocol) ||
    !correlationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      correlationId,
    ) ||
    !verifierHash ||
    !/^[0-9a-f]{64}$/u.test(verifierHash) ||
    !deviceJkt ||
    !/^[A-Za-z0-9_-]{43}$/u.test(deviceJkt) ||
    !portSecret ||
    !/^[0-9a-f]{64}$/u.test(portSecret)
  ) {
    return null;
  }
  return { correlationId, verifierHash, deviceJkt, portSecret, protocol };
};

const DESKTOP_ACCOUNT_LINK_STORAGE_KEY = "stella.desktop-account-link";

const storedDesktopAccountLinkSchema = v.object({
  hash: v.string(),
  savedAt: v.number(),
});

const removeDesktopAccountLinkHash = () => {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
};

/**
 * Moves a desktop linking challenge out of the address bar into this tab's
 * session storage, so it survives a sign-in or organization redirect (which
 * keep only the path and query). The desktop settings page consumes it once.
 */
export const stashDesktopAccountLink = () => {
  if (typeof window === "undefined") {
    return;
  }
  const hash = window.location.hash;
  if (!hash.startsWith(`${DESKTOP_ACCOUNT_LINK_HASH}?`)) {
    return;
  }
  browserStateStorage("session").setItem(
    DESKTOP_ACCOUNT_LINK_STORAGE_KEY,
    serializeStoredJson({
      hash,
      savedAt: Temporal.Now.instant().epochMilliseconds,
    }),
  );
  removeDesktopAccountLinkHash();
};

const takeStashedDesktopAccountLink = () => {
  const storage = browserStateStorage("session");
  const stored = readStoredJson(
    storage.getItem(DESKTOP_ACCOUNT_LINK_STORAGE_KEY),
    storedDesktopAccountLinkSchema,
  );
  storage.removeItem(DESKTOP_ACCOUNT_LINK_STORAGE_KEY);
  if (
    !stored ||
    Temporal.Now.instant().epochMilliseconds - stored.savedAt >=
      DESKTOP_ACCOUNT_CHALLENGE_TTL_MS
  ) {
    return null;
  }
  return stored.hash;
};

export const captureDesktopAccountLink = () => {
  const addressHash = window.location.hash;
  // Always consume the stash, so an older challenge never outlives a newer
  // one that arrived in the address bar.
  const stashed = takeStashedDesktopAccountLink();
  const hash = addressHash.startsWith(`${DESKTOP_ACCOUNT_LINK_HASH}?`)
    ? addressHash
    : stashed;
  if (!hash?.startsWith(`${DESKTOP_ACCOUNT_LINK_HASH}?`)) {
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
  if (hash === addressHash) {
    removeDesktopAccountLinkHash();
  }
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

/** The challenge fields a bridge status must be signed for. */
type DesktopConnectionChallenge = Pick<
  DesktopAccountChallenge,
  "correlationId" | "verifierHash" | "deviceJkt" | "portSecret"
>;

type VerifyDesktopConnectionOptions = {
  payload: unknown;
  challenge: DesktopConnectionChallenge;
  nowSeconds: number;
};

/**
 * Accepts a status only when the app signed it with this challenge's port
 * secret over `correlationId\nverifierHash\ndeviceJkt\nstatus\ntimestamp`
 * within the skew window: a status signed for any other challenge fails.
 */
export const verifyDesktopConnectionStatus = async ({
  payload,
  challenge: { correlationId, verifierHash, deviceJkt, portSecret },
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
      `${correlationId}\n${verifierHash}\n${deviceJkt}\n${status}\n${payload.timestamp}`,
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

  return unwrapApiResponse(response) satisfies DesktopEditHandoff;
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

  return unwrapApiResponse(response);
};

/** Hands a `stella://` link to the operating system. */
export const openDesktopUrl = (desktopUrl: string) => {
  window.location.href = desktopUrl;
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

/** Whether the desktop app asked this tab to approve a link just now. */
export const hasDesktopAccountChallenge = () =>
  accountAttempt?.type === "challenge" &&
  accountAttempt.challenge.expiresAt > Temporal.Now.instant().epochMilliseconds;

type ReadDesktopConnectionOptions = {
  challenge: DesktopConnectionChallenge;
  request?: typeof fetchWithTimeout;
};

export const readDesktopConnection = async ({
  challenge,
  request = fetchWithTimeout,
}: ReadDesktopConnectionOptions) => {
  const { correlationId, portSecret } = challenge;
  const query = new URLSearchParams({ correlationId });
  const path = `/v1/connection?${query.toString()}`;
  const url = `${DESKTOP_BRIDGE_URL}${path}`;
  const fetched = await Result.tryPromise({
    try: async () =>
      await request(
        url,
        loopback({
          credentials: "omit",
          method: "GET",
          referrerPolicy: "no-referrer",
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
        challenge,
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

/**
 * Whether the app on this computer proves, over the loopback bridge, that it
 * started this exact challenge and still waits for it. A link crafted
 * elsewhere carries a port secret no local app holds, so it never proves.
 */
const provesLocalDesktopChallenge = async (
  challenge: DesktopConnectionChallenge,
) => {
  const status = await readDesktopConnection({ challenge });
  return status.isOk() && status.value === "pending";
};

type LinkDesktopAccountOptions = Pick<LinkAccountRequest, "apiBaseUrl"> & {
  approval: DesktopLinkApproval;
  /** Receives the app link once the grant exists, so the page can offer it again. */
  onDesktopOpening: (desktopUrl: string) => void;
};

export const linkDesktopAccount = async ({
  apiBaseUrl,
  approval,
  onDesktopOpening,
}: LinkDesktopAccountOptions) => {
  captureDesktopAccountLink();
  const attempt = accountAttempt;
  if (attempt?.type === "update-required") {
    accountAttempt = null;
    return Result.ok({
      status: "update-required",
    } as const satisfies DesktopLinkOutcome);
  }
  const challenge = attempt?.challenge;
  const challengeLive =
    challenge !== undefined &&
    challenge.expiresAt > Temporal.Now.instant().epochMilliseconds;
  // The challenge stays in place until the page may answer it, so a refused
  // proof still leaves it for the explicit approval.
  if (
    approval === "local-proof" &&
    (!challengeLive || !(await provesLocalDesktopChallenge(challenge)))
  ) {
    return Result.ok({
      status: "approval-required",
    } as const satisfies DesktopLinkOutcome);
  }
  if (accountAttempt === attempt) {
    accountAttempt = null;
  }
  if (!challengeLive) {
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
      const grant = unwrapApiResponse(
        await api["desktop-registry"].grant.post(
          desktopAccountGrantRequest(challenge),
        ),
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
      const desktopUrl = `stella://account/complete?${params.toString()}`;
      onDesktopOpening(desktopUrl);
      openDesktopUrl(desktopUrl);
      const deadline = Math.min(
        challenge.expiresAt,
        new Date(grant.expiresAt).getTime(),
      );
      while (Temporal.Now.instant().epochMilliseconds < deadline) {
        const connection = await readDesktopConnection({ challenge });
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
        await sleep(DESKTOP_HANDOFF_POLL_INTERVAL_MS);
      }
      throw new DesktopBridgeUnavailableError();
    },
    catch: (cause) => cause,
  });
};

export const openFileInDesktop = async (input: OpenFileInDesktopInput) => {
  const handoff = await createDesktopEditHandoff(input);
  openDesktopUrl(handoff.deepLinkUrl);
  return {
    type: "handoff-pending",
    waitUntilOpened: waitForDesktopEditHandoffOpened({
      expiresAt: handoff.expiresAt,
      handoffId: handoff.handoffId,
      workspaceId: input.workspaceId,
    }),
  } satisfies OpenFileInDesktopResult;
};
