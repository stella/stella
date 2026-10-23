import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Hocuspocus } from "@hocuspocus/server";
import type {
  Configuration as HocuspocusConfiguration,
  Document as HocuspocusDocument,
  onStoreDocumentPayload,
  WebSocketLike,
} from "@hocuspocus/server";
import { isPanic, panic, Result, TaggedError } from "better-result";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/bun";
import * as v from "valibot";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import {
  FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
  FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
  FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_REDIS_SCOPE,
  FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME,
  folioCollabSnapshotLoadResponseSchema,
  parseFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";
import { FetchBoundaryError } from "@stll/errors";
import type { RedisConnectionSettings } from "@stll/redis-config";
import type { StorePolicyStatus } from "@stll/redis-config/store-policy";
import { Temporal } from "@stll/time";

import { isSecureCollabRedisUrl, isSecureStellaApiUrl } from "./env-schema";
import { logCollabEvent } from "./log";
import { createCollabRedisClient } from "./redis-client";

type CollabAuthContext = {
  join: CollabRoomJoin;
  roomId: string;
  tokenState: CollabRoomTokenState;
  userId: string;
  userName: string;
};

/**
 * One authorized join holds one count on its room token state. Hocuspocus
 * copies the auth context when it merges hook results, so the join keeps its
 * identity in this object and is released exactly once.
 */
type CollabRoomJoin = {
  released: boolean;
};

type CollabRoomJoinRelease = {
  context: CollabAuthContext;
  documentName: string;
  socketId: string;
};

type CollabRoomTokenState = {
  activeConnections: number;
  canEdit: boolean;
  generation: number;
  refreshInFlight: Promise<string> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  roomId: string;
  roomName: string;
  token: string;
  tokenExpiresAtMs: number;
};

type CollabRoomHeartbeatState = {
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  tokenState: CollabRoomTokenState;
};

type ManagedWebSocketLike = WebSocketLike & {
  markClosed: () => void;
};

type ManagedConnection = {
  roomConnectionCounts: Map<string, number>;
  socket: ManagedWebSocketLike;
  socketIds: Set<string>;
};

type CreateCollabServerBaseOptions = {
  apiUrl: string;
  serviceToken: string;
  debounceMs?: number;
  hostname?: string;
  maxDebounceMs?: number;
  port: number;
  roomHeartbeatIntervalMs?: number;
  shutdownDrainTimeoutMs?: number;
  snapshotStoreRetryBaseDelayMs?: number;
  snapshotStoreRetryMaxDelayMs?: number;
};

/**
 * A snapshot store that has not landed. Its edits exist only in this process,
 * so the document stays loaded until a store lands or the room is retired.
 */
type PendingSnapshotStore = {
  failedAttempts: number;
  payload: onStoreDocumentPayload<CollabAuthContext>;
  timer: ReturnType<typeof setTimeout> | null;
};

type CreateCollabServerOptions = CreateCollabServerBaseOptions &
  (
    | {
        mode: "redis";
        redisTlsRejectUnauthorized?: boolean;
        redisSettings?: RedisConnectionSettings;
        redisUrl: string;
      }
    | {
        mode?: "single-process";
        redisTlsRejectUnauthorized?: never;
        redisSettings?: never;
        redisUrl?: never;
      }
  );

const authorizeResponseSchema = v.strictObject({
  canEdit: v.boolean(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  roomId: v.string(),
  roomName: v.string(),
  tokenExpiresAt: v.string(),
  userId: v.string(),
  userName: v.string(),
});

const refreshTokenResponseSchema = v.strictObject({
  canEdit: v.boolean(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  token: v.string(),
  tokenExpiresAt: v.string(),
});

const storeSnapshotResponseSchema = v.strictObject({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  snapshotRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
  storedAt: v.string(),
});

const heartbeatResponseSchema = v.strictObject({
  activeAt: v.string(),
});

const flushRequestSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    type: v.literal(FOLIO_COLLAB_FLUSH_REQUEST_TYPE),
  }),
);

const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const ROOM_ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
const REDIS_LOCK_TIMEOUT_MS = 30_000;
const REDIS_INITIAL_SYNC_TIMEOUT_MS = 3000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SNAPSHOT_REVISION_RETRY_LIMIT = 3;
const SNAPSHOT_STORE_RETRY_BASE_DELAY_MS = 1000;
const SNAPSHOT_STORE_RETRY_MAX_DELAY_MS = 30_000;
/** API answers meaning the room no longer accepts snapshots at all. */
const ROOM_RETIRING_SNAPSHOT_STORE_STATUSES: ReadonlySet<number> = new Set([
  403, 404,
]);
const FOLIO_COLLABORATOR_COLOR_SPACE = 16_777_215;
const REDIS_RETRY_CLOSE_REASON = "Collaboration coordination unavailable";
const ROOM_GENERATION_CLOSE_REASON = "Collaboration room generation changed";

const presenceColorFromUserId = (userId: string) => {
  let hash = 0;
  for (const character of userId) {
    hash =
      (hash * 31 + (character.codePointAt(0) ?? 0)) %
      FOLIO_COLLABORATOR_COLOR_SPACE;
  }
  const color = (hash * 2_654_435_761) % FOLIO_COLLABORATOR_COLOR_SPACE;
  return `#${color.toString(16).padStart(6, "0")}`;
};

const readPresenceUserId = (state: unknown) => {
  if (state === null || typeof state !== "object" || !("user" in state)) {
    return null;
  }
  const user = state.user;
  if (user === null || typeof user !== "object" || !("id" in user)) {
    return null;
  }
  return typeof user.id === "string" ? user.id : null;
};

class CollabTokenExpiryError extends TaggedError("CollabTokenExpiryError")<{
  message: string;
  cause: unknown;
}> {}

/** The room moved to another generation; its in-memory state must not land. */
class CollabSnapshotRoomRetiredError extends TaggedError(
  "CollabSnapshotRoomRetiredError",
)<{
  message: string;
  cause: unknown;
}> {}

class CollabSnapshotPendingError extends TaggedError(
  "CollabSnapshotPendingError",
)<{
  message: string;
}> {}

/**
 * Every failed store is retried unless the room itself is retired: a newer
 * generation or rematerialization replaced it, the API refuses the room, or a
 * server invariant broke. Size refusals stay retryable, so a room above the
 * API limit keeps its edits and lands once the limit admits it.
 */
const snapshotStoreFailureOutcome = (error: unknown) => {
  if (error instanceof CollabSnapshotRoomRetiredError || isPanic(error)) {
    return "retired";
  }
  if (
    error instanceof FetchBoundaryError &&
    error.status !== undefined &&
    ROOM_RETIRING_SNAPSHOT_STORE_STATUSES.has(error.status)
  ) {
    return "retired";
  }
  return "retry";
};

const parseTokenExpiresAt = (value: string) => {
  const expiresAt = Result.try(() => Temporal.Instant.from(value));
  if (expiresAt.isErr()) {
    throw new CollabTokenExpiryError({
      message: "Stella API returned an invalid token expiry.",
      cause: expiresAt.error,
    });
  }

  return expiresAt.value.epochMilliseconds;
};

const tokenRefreshDelayMs = (tokenExpiresAtMs: number) => {
  const msUntilExpiry =
    tokenExpiresAtMs - Temporal.Now.instant().epochMilliseconds;
  if (msUntilExpiry <= 0) {
    return 0;
  }

  const leewayMs = Math.min(
    TOKEN_REFRESH_LEEWAY_MS,
    Math.floor(msUntilExpiry / 2),
  );

  return Math.max(0, msUntilExpiry - leewayMs);
};

const postJson = async <TSchema extends v.GenericSchema>({
  apiUrl,
  authorizationToken,
  body,
  path,
  schema,
}: {
  apiUrl: string;
  authorizationToken?: string;
  body: Record<string, unknown>;
  path: string;
  schema: TSchema;
}): Promise<v.InferOutput<TSchema>> => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorizationToken !== undefined) {
    headers.set("Authorization", `Bearer ${authorizationToken}`);
  }

  // oxlint-disable-next-line require-safe-outbound-target/require-safe-outbound-target -- posts only to the operator-configured API origin
  const response = await fetch(`${apiUrl}/v1${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new FetchBoundaryError({
      url: `${apiUrl}/v1${path}`,
      status: response.status,
      statusText: response.statusText,
      message: `Stella API request failed: ${response.status}`,
    });
  }

  return v.parse(schema, await response.json());
};

/**
 * Hocuspocus runs `onDisconnect` only for joins that reached a document. A
 * join whose document load fails never gets a connection, so the failure is
 * handed back here to release what `onAuthenticate` acquired for it.
 */
class CollabHocuspocus extends Hocuspocus<CollabAuthContext> {
  readonly #releaseJoin: (join: CollabRoomJoinRelease) => void;

  constructor(
    releaseJoin: (join: CollabRoomJoinRelease) => void,
    configuration: Partial<HocuspocusConfiguration<CollabAuthContext>>,
  ) {
    super(configuration);
    this.#releaseJoin = releaseJoin;
  }

  override async createDocument(
    ...args: Parameters<Hocuspocus<CollabAuthContext>["createDocument"]>
  ) {
    try {
      return await super.createDocument(...args);
    } catch (error) {
      const [documentName, , socketId, , context] = args;
      if (context !== undefined) {
        this.#releaseJoin({ context, documentName, socketId });
      }
      throw error;
    }
  }
}

const createManagedWebSocket = (peer: Peer): ManagedWebSocketLike => {
  let readyState: number = WebSocket.OPEN;

  return {
    close(code?: number, reason?: string) {
      if (readyState >= WebSocket.CLOSING) {
        return;
      }

      readyState = WebSocket.CLOSING;
      peer.close(code, reason);
    },
    markClosed() {
      readyState = WebSocket.CLOSED;
    },
    get readyState() {
      return readyState;
    },
    send(data) {
      if (readyState >= WebSocket.CLOSING) {
        return;
      }

      peer.send(data);
    },
  };
};

export const createCollabServer = async (
  options: CreateCollabServerOptions,
) => {
  const {
    apiUrl,
    debounceMs = 2000,
    hostname = "0.0.0.0",
    maxDebounceMs = 10_000,
    port,
    roomHeartbeatIntervalMs = ROOM_ACTIVITY_HEARTBEAT_INTERVAL_MS,
    serviceToken,
    shutdownDrainTimeoutMs = SHUTDOWN_DRAIN_TIMEOUT_MS,
    snapshotStoreRetryBaseDelayMs = SNAPSHOT_STORE_RETRY_BASE_DELAY_MS,
    snapshotStoreRetryMaxDelayMs = SNAPSHOT_STORE_RETRY_MAX_DELAY_MS,
  } = options;
  const mode = options.mode ?? "single-process";
  if (!isSecureStellaApiUrl(apiUrl)) {
    panic(
      "STELLA_API_URL must use HTTPS unless it targets a loopback address.",
    );
  }

  if (options.mode === "redis" && !isSecureCollabRedisUrl(options.redisUrl)) {
    panic(
      "STELLA_COLLAB_REDIS_URL must use database 0 and rediss:// unless it targets a loopback address.",
    );
  }

  let redisReady = mode === "single-process";
  let redisUnavailableLogged = false;
  let shuttingDown = false;
  const managedConnections = new Set<ManagedConnection>();
  const managedConnectionsByRequest = new Map<Request, ManagedConnection>();
  const managedConnectionsBySocketId = new Map<string, ManagedConnection>();
  const tokenStatesBySocketId = new Map<string, CollabRoomTokenState>();
  const closeResetRoomConnections = ({
    roomName,
    resetGeneration,
  }: {
    roomName: string;
    resetGeneration: number;
  }) => {
    const closedSockets = new Set<ManagedWebSocketLike>();
    for (const [socketId, tokenState] of tokenStatesBySocketId) {
      if (
        tokenState.roomName !== roomName ||
        tokenState.generation !== resetGeneration
      ) {
        continue;
      }
      const connection = managedConnectionsBySocketId.get(socketId);
      if (connection === undefined || closedSockets.has(connection.socket)) {
        continue;
      }
      closedSockets.add(connection.socket);
      connection.socket.close(
        FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
        ROOM_GENERATION_CLOSE_REASON,
      );
    }
    clearRoomTokens(roomName, resetGeneration);
  };
  const closeManagedConnectionsForRetry = (reason: string) => {
    for (const { socket } of managedConnections) {
      socket.close(FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE, reason);
    }
  };
  const closeManagedRoomConnections = (
    roomName: string,
    code: number,
    reason: string,
  ) => {
    for (const { roomConnectionCounts, socket } of managedConnections) {
      if (roomConnectionCounts.has(roomName)) {
        socket.close(code, reason);
      }
    }
  };
  let publishPolicyStatus: StorePolicyStatus | "checking" = "checking";
  const redisClients =
    options.mode === "redis"
      ? {
          publish: createCollabRedisClient({
            storeClass: "durable-coordination",
            redisUrl: options.redisUrl,
            rejectUnauthorized: options.redisTlsRejectUnauthorized ?? true,
            settings: options.redisSettings ?? {},
            onPolicyStatus: (status) => {
              publishPolicyStatus = status;
              updateRedisReadiness();
            },
          }),
          subscribe: createCollabRedisClient({
            storeClass: "cache",
            redisUrl: options.redisUrl,
            rejectUnauthorized: options.redisTlsRejectUnauthorized ?? true,
            settings: options.redisSettings ?? {},
          }),
        }
      : null;
  const extensionClients =
    redisClients === null ? [] : [redisClients.publish, redisClients.subscribe];
  const redisExtension =
    redisClients !== null
      ? new RedisExtension({
          awaitInitialSyncTimeout: REDIS_INITIAL_SYNC_TIMEOUT_MS,
          createClient: () =>
            extensionClients.shift() ??
            panic(
              "Collaboration extension requested an undeclared Redis client",
            ),
          lockTimeout: REDIS_LOCK_TIMEOUT_MS,
          prefix: FOLIO_COLLAB_REDIS_SCOPE,
        })
      : null;
  if (extensionClients.length !== 0) {
    panic("Collaboration extension did not consume its declared Redis clients");
  }

  const updateRedisReadiness = () => {
    if (redisExtension === null || shuttingDown) {
      return;
    }

    const nextReady =
      publishPolicyStatus !== "checking" &&
      publishPolicyStatus !== "refused" &&
      redisExtension.pub.status === "ready" &&
      redisExtension.sub.status === "ready";
    if (nextReady === redisReady) {
      return;
    }

    redisReady = nextReady;
    if (redisReady) {
      redisUnavailableLogged = false;
      logCollabEvent({ event: "redis_ready", level: "info" });
      return;
    }

    closeManagedConnectionsForRetry(REDIS_RETRY_CLOSE_REASON);
  };

  const markRedisUnavailable = (
    transport: "publish" | "subscribe",
    signal: "close" | "end" | "error",
  ) => {
    if (shuttingDown) {
      return;
    }
    if (transport === "publish" && signal !== "error") {
      publishPolicyStatus = "checking";
    }

    const wasReady = redisReady;
    redisReady = false;
    if (!redisUnavailableLogged) {
      redisUnavailableLogged = true;
      logCollabEvent({
        event: "redis_unavailable",
        level: "error",
        signal,
        transport,
      });
    }
    if (wasReady) {
      closeManagedConnectionsForRetry(REDIS_RETRY_CLOSE_REASON);
    }
  };

  if (redisExtension !== null) {
    redisExtension.pub.on("ready", updateRedisReadiness);
    redisExtension.pub.on("error", () =>
      markRedisUnavailable("publish", "error"),
    );
    redisExtension.pub.on("close", () =>
      markRedisUnavailable("publish", "close"),
    );
    redisExtension.pub.on("end", () => markRedisUnavailable("publish", "end"));
    redisExtension.sub.on("ready", updateRedisReadiness);
    redisExtension.sub.on("error", () =>
      markRedisUnavailable("subscribe", "error"),
    );
    redisExtension.sub.on("close", () =>
      markRedisUnavailable("subscribe", "close"),
    );
    redisExtension.sub.on("end", () =>
      markRedisUnavailable("subscribe", "end"),
    );
    updateRedisReadiness();
    // The subscriber starts through the extension's initial SUBSCRIBE. The
    // publisher also needs an initial connection before any room is opened.
    void Result.tryPromise({
      try: async () => await redisExtension.pub.connect(),
      catch: (cause: unknown) => cause,
    }).then((connected) => {
      if (Result.isError(connected)) {
        markRedisUnavailable("publish", "error");
      }
      return;
    });
  }

  const tokenStates = new Map<string, CollabRoomTokenState>();
  const roomHeartbeatStates = new Map<
    CollabRoomTokenState,
    CollabRoomHeartbeatState
  >();
  const documentSnapshots = new WeakMap<
    HocuspocusDocument,
    { generation: number; roomId: string; snapshotRevision: number }
  >();
  // Debounced persistence and an explicit publication flush can overlap. The
  // capture plus store must stay ordered so a flush acknowledgement always
  // describes the snapshot that remains at the durable room pointer.
  const documentSnapshotStoreTails = new WeakMap<
    HocuspocusDocument,
    Promise<void>
  >();
  const roomCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelRoomCleanup = (roomName: string) => {
    const timer = roomCleanupTimers.get(roomName);
    if (timer === undefined) {
      return;
    }

    clearTimeout(timer);
    roomCleanupTimers.delete(roomName);
  };

  const clearRoomTokenRefresh = (state: CollabRoomTokenState) => {
    if (!state.refreshTimer) {
      return;
    }

    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  };

  const clearRoomHeartbeat = (tokenState: CollabRoomTokenState) => {
    const state = roomHeartbeatStates.get(tokenState);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }
    roomHeartbeatStates.delete(tokenState);
  };

  const clearRoomTokens = (roomName: string, generation?: number) => {
    for (const tokenState of roomHeartbeatStates.keys()) {
      if (
        tokenState.roomName === roomName &&
        (generation === undefined || tokenState.generation === generation)
      ) {
        clearRoomHeartbeat(tokenState);
      }
    }
    for (const [token, state] of tokenStates) {
      if (
        state.roomName !== roomName ||
        (generation !== undefined && state.generation !== generation)
      ) {
        continue;
      }
      clearRoomTokenRefresh(state);
      tokenStates.delete(token);
    }
  };

  const releaseRoomJoin = ({
    context,
    documentName,
    socketId,
  }: CollabRoomJoinRelease) => {
    if (context.join.released) {
      return;
    }
    context.join.released = true;
    const { tokenState } = context;
    tokenState.activeConnections = Math.max(
      0,
      tokenState.activeConnections - 1,
    );
    if (tokenState.activeConnections === 0) {
      // A token state without joins renews nothing: stop its activity lease
      // and its refresh so the room reads as idle.
      clearRoomHeartbeat(tokenState);
      clearRoomTokenRefresh(tokenState);
      if (tokenStates.get(tokenState.token) === tokenState) {
        tokenStates.delete(tokenState.token);
      }
    }
    tokenStatesBySocketId.delete(socketId);
    const managedConnection = managedConnectionsBySocketId.get(socketId);
    const connectionCount =
      managedConnection?.roomConnectionCounts.get(documentName);
    if (managedConnection === undefined || connectionCount === undefined) {
      return;
    }
    if (connectionCount === 1) {
      managedConnection.roomConnectionCounts.delete(documentName);
      return;
    }
    managedConnection.roomConnectionCounts.set(
      documentName,
      connectionCount - 1,
    );
  };

  const scheduleTokenRefresh = (
    state: CollabRoomTokenState,
    delayMs = tokenRefreshDelayMs(state.tokenExpiresAtMs),
  ) => {
    clearRoomTokenRefresh(state);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void refreshRoomToken(state).catch(() => {
        hocuspocus.closeConnections(state.roomName);
        clearRoomTokens(state.roomName);
      });
    }, delayMs);
  };

  const upsertRoomToken = ({
    canEdit,
    generation,
    roomId,
    roomName,
    token,
    tokenExpiresAt,
  }: {
    canEdit: boolean;
    generation: number;
    roomId: string;
    roomName: string;
    token: string;
    tokenExpiresAt: string;
  }) => {
    const tokenExpiresAtMs = parseTokenExpiresAt(tokenExpiresAt);
    const existing = tokenStates.get(token);

    if (existing && existing.tokenExpiresAtMs > tokenExpiresAtMs) {
      return existing;
    }

    if (existing) {
      if (existing.token !== token) {
        existing.refreshInFlight = null;
      }
      existing.token = token;
      existing.tokenExpiresAtMs = tokenExpiresAtMs;
      existing.canEdit = canEdit;
      existing.generation = generation;
      existing.roomId = roomId;
      existing.roomName = roomName;
      scheduleTokenRefresh(existing);
      return existing;
    }

    const state: CollabRoomTokenState = {
      activeConnections: 0,
      canEdit,
      generation,
      refreshInFlight: null,
      refreshTimer: null,
      roomId,
      roomName,
      token,
      tokenExpiresAtMs,
    };
    tokenStates.set(token, state);
    scheduleTokenRefresh(state);

    return state;
  };

  const refreshRoomToken = async (state: CollabRoomTokenState) => {
    if (state.refreshInFlight) {
      return await state.refreshInFlight;
    }

    const refresh = (async () => {
      const token = state.token;

      const refreshed = await postJson({
        apiUrl,
        body: {
          roomId: state.roomId,
          token,
        },
        path: "/folio-collab-rooms/refresh-token",
        schema: refreshTokenResponseSchema,
      });

      if (state.token !== token) {
        return state.token;
      }

      if (refreshed.token !== token) {
        tokenStates.delete(token);
        tokenStates.set(refreshed.token, state);
      }
      state.token = refreshed.token;
      state.tokenExpiresAtMs = parseTokenExpiresAt(refreshed.tokenExpiresAt);
      const requiresReconnect =
        state.canEdit !== refreshed.canEdit ||
        state.generation !== refreshed.generation;
      state.canEdit = refreshed.canEdit;
      state.generation = refreshed.generation;
      if (tokenStates.get(state.token) === state) {
        scheduleTokenRefresh(state);
        if (requiresReconnect) {
          hocuspocus.closeConnections(state.roomName);
        }
      }

      return state.token;
    })();

    state.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (state.refreshInFlight === refresh) {
        state.refreshInFlight = null;
      }
    }
  };

  const getFreshRoomToken = async (state: CollabRoomTokenState) => {
    if (
      state.tokenExpiresAtMs - Temporal.Now.instant().epochMilliseconds >
      TOKEN_REFRESH_LEEWAY_MS
    ) {
      return state.token;
    }

    return await refreshRoomToken(state);
  };

  const heartbeatRoom = async (state: CollabRoomTokenState) => {
    const token = await getFreshRoomToken(state);
    await postJson({
      apiUrl,
      body: { roomId: state.roomId, token },
      path: "/folio-collab-rooms/heartbeat",
      schema: heartbeatResponseSchema,
    });
  };

  const scheduleRoomHeartbeat = (tokenState: CollabRoomTokenState) => {
    const state = roomHeartbeatStates.get(tokenState);
    if (!state || state.timer) {
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      const request = heartbeatRoom(state.tokenState);
      state.inFlight = request;
      void request
        .then(() => {
          if (roomHeartbeatStates.get(tokenState) === state) {
            state.inFlight = null;
            scheduleRoomHeartbeat(tokenState);
          }
          return undefined;
        })
        .catch(() => {
          hocuspocus.closeConnections(state.tokenState.roomName);
          clearRoomTokens(state.tokenState.roomName);
        });
    }, roomHeartbeatIntervalMs);
  };

  const ensureRoomHeartbeat = async (tokenState: CollabRoomTokenState) => {
    const existing = roomHeartbeatStates.get(tokenState);
    if (existing) {
      if (existing.inFlight) {
        await existing.inFlight;
      }
      return;
    }

    const state: CollabRoomHeartbeatState = {
      inFlight: null,
      timer: null,
      tokenState,
    };
    roomHeartbeatStates.set(tokenState, state);
    const request = heartbeatRoom(tokenState);
    state.inFlight = request;
    try {
      await request;
      state.inFlight = null;
      scheduleRoomHeartbeat(tokenState);
    } catch (error) {
      clearRoomHeartbeat(tokenState);
      throw error;
    }
  };

  const pendingSnapshotStores = new Map<
    HocuspocusDocument,
    PendingSnapshotStore
  >();
  const shutdownFlushedDocuments = new WeakSet<HocuspocusDocument>();
  let snapshotStoreRetriesClosed = false;

  const snapshotRoomIdForLog = (document: HocuspocusDocument) =>
    documentSnapshots.get(document)?.roomId ?? document.name;

  const settleSnapshotStore = (document: HocuspocusDocument) => {
    const pending = pendingSnapshotStores.get(document);
    if (pending === undefined) {
      return;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
    }
    pendingSnapshotStores.delete(document);
  };

  const scheduleSnapshotStoreRetry = (
    payload: onStoreDocumentPayload<CollabAuthContext>,
    failedAttempts: number,
  ) => {
    const { document } = payload;
    const previous = pendingSnapshotStores.get(document);
    if (previous?.timer) {
      clearTimeout(previous.timer);
    }
    if (snapshotStoreRetriesClosed) {
      pendingSnapshotStores.delete(document);
      logCollabEvent({
        event: "snapshot_store_abandoned",
        level: "error",
        roomId: snapshotRoomIdForLog(document),
      });
      return null;
    }
    // Shutdown gives each pending room one immediate attempt inside the
    // drain window before the usual backoff resumes.
    const flushForShutdown =
      shuttingDown && !shutdownFlushedDocuments.has(document);
    if (flushForShutdown) {
      shutdownFlushedDocuments.add(document);
    }
    const delayMs = flushForShutdown
      ? 0
      : Math.min(
          snapshotStoreRetryBaseDelayMs * 2 ** Math.max(0, failedAttempts - 1),
          snapshotStoreRetryMaxDelayMs,
        );
    const pending: PendingSnapshotStore = {
      failedAttempts,
      payload,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      retrySnapshotStore(document);
    }, delayMs);
    pendingSnapshotStores.set(document, pending);
    return delayMs;
  };

  const retrySnapshotStore = (document: HocuspocusDocument) => {
    const pending = pendingSnapshotStores.get(document);
    if (pending === undefined) {
      return;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (hocuspocus.documents.get(document.name) !== document) {
      pendingSnapshotStores.delete(document);
      logCollabEvent({
        event: "snapshot_store_abandoned",
        level: "error",
        roomId: snapshotRoomIdForLog(document),
      });
      return;
    }
    void hocuspocus
      .storeDocumentHooks(document, pending.payload, true)
      .then(() => {
        // A coordination lock held by another replica skips the store without
        // running onStoreDocument; keep the pending store on its backoff.
        const current = pendingSnapshotStores.get(document);
        if (current?.timer === null) {
          scheduleSnapshotStoreRetry(current.payload, current.failedAttempts);
        }
        return undefined;
      })
      .catch((error: unknown) => {
        if (snapshotStoreFailureOutcome(error) === "retired") {
          settleSnapshotStore(document);
          logCollabEvent({
            event: "snapshot_store_retired",
            level: "warn",
            roomId: snapshotRoomIdForLog(document),
          });
          return;
        }

        const current = pendingSnapshotStores.get(document);
        if (current?.timer === null) {
          scheduleSnapshotStoreRetry(current.payload, current.failedAttempts);
        }
      });
  };

  const storeRoomSnapshot = async (document: HocuspocusDocument) => {
    const snapshot = documentSnapshots.get(document);
    if (snapshot === undefined) {
      panic("Collaboration room snapshot generation is missing.");
    }

    const storeSnapshotAttempt = async (attempt: number): Promise<number> => {
      if (attempt >= SNAPSHOT_REVISION_RETRY_LIMIT) {
        throw new FetchBoundaryError({
          url: `${apiUrl}/v1/folio-collab-rooms/snapshot/store`,
          status: 428,
          statusText: "Precondition Required",
          message: "Collaboration snapshot revision did not converge.",
        });
      }
      try {
        const stored = await postJson({
          apiUrl,
          authorizationToken: serviceToken,
          body: {
            expectedGeneration: snapshot.generation,
            expectedSnapshotRevision: snapshot.snapshotRevision,
            roomId: snapshot.roomId,
            snapshotBase64: Buffer.from(encodeStateAsUpdate(document)).toString(
              "base64",
            ),
          },
          path: "/folio-collab-rooms/snapshot/store",
          schema: storeSnapshotResponseSchema,
        });
        snapshot.snapshotRevision = stored.snapshotRevision;
        return stored.snapshotRevision;
      } catch (error) {
        if (!(error instanceof FetchBoundaryError)) {
          throw error;
        }
        if (error.status === 409) {
          closeManagedRoomConnections(
            document.name,
            FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
            ROOM_GENERATION_CLOSE_REASON,
          );
          clearRoomTokens(document.name);
          logCollabEvent({
            event: "snapshot_generation_conflict",
            generation: snapshot.generation,
            level: "error",
            roomId: snapshot.roomId,
          });
          throw new CollabSnapshotRoomRetiredError({
            message: "Collaboration room generation changed.",
            cause: error,
          });
        }
        if (error.status !== 428) {
          throw error;
        }

        const current = await postJson({
          apiUrl,
          authorizationToken: serviceToken,
          body: { roomId: snapshot.roomId },
          path: "/folio-collab-rooms/snapshot/load",
          schema: folioCollabSnapshotLoadResponseSchema,
        });
        switch (current.loadOutcome) {
          case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx:
            closeResetRoomConnections({
              roomName: document.name,
              resetGeneration: current.resetGeneration,
            });
            logCollabEvent({
              event: "snapshot_refused_rematerialization",
              generation: current.resetGeneration,
              level: "warn",
              roomId: snapshot.roomId,
            });
            throw new CollabSnapshotRoomRetiredError({
              message: "Collaboration room requires rematerialization.",
              cause: error,
            });
          case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded:
            break;
          default: {
            current satisfies never;
            return panic("Unhandled snapshot load outcome");
          }
        }
        if (current.generation !== snapshot.generation) {
          closeManagedRoomConnections(
            document.name,
            FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
            ROOM_GENERATION_CLOSE_REASON,
          );
          clearRoomTokens(document.name);
          throw new CollabSnapshotRoomRetiredError({
            message: "Collaboration room generation changed.",
            cause: error,
          });
        }
        if (current.snapshotBase64 !== null) {
          applyUpdate(document, Buffer.from(current.snapshotBase64, "base64"));
        }
        snapshot.snapshotRevision = current.snapshotRevision;
        return await storeSnapshotAttempt(attempt + 1);
      }
    };
    return await storeSnapshotAttempt(0);
  };

  const queueRoomSnapshotStore = async (document: HocuspocusDocument) => {
    const previous = documentSnapshotStoreTails.get(document);
    const current = (previous ?? Promise.resolve()).then(
      async () => await storeRoomSnapshot(document),
    );
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    documentSnapshotStoreTails.set(document, tail);
    void tail.then(() => {
      if (documentSnapshotStoreTails.get(document) === tail) {
        documentSnapshotStoreTails.delete(document);
      }
      return undefined;
    });
    const snapshotRevision = await current;
    // Every store captures the whole document, so any landed store covers
    // the edits an earlier failed store carried.
    settleSnapshotStore(document);
    return snapshotRevision;
  };

  const hocuspocus = new CollabHocuspocus(releaseRoomJoin, {
    debounce: debounceMs,
    async beforeUnloadDocument({ document }) {
      await Promise.resolve();
      if (pendingSnapshotStores.has(document)) {
        throw new CollabSnapshotPendingError({
          message: "Collaboration room keeps its document until a store lands.",
        });
      }
    },
    async afterUnloadDocument({ documentName }) {
      cancelRoomCleanup(documentName);
      roomCleanupTimers.set(
        documentName,
        setTimeout(() => {
          roomCleanupTimers.delete(documentName);
          if (hocuspocus.documents.has(documentName)) {
            return;
          }

          clearRoomTokens(documentName);
        }, REDIS_INITIAL_SYNC_TIMEOUT_MS),
      );
      await Promise.resolve();
    },
    extensions: redisExtension === null ? [] : [redisExtension],
    maxDebounce: maxDebounceMs,
    async onAuthenticate({
      connectionConfig,
      documentName,
      request,
      socketId,
      token,
    }) {
      const requestedRoomId = parseFolioCollabRoomName(documentName);
      if (requestedRoomId === null) {
        panic("Collaboration room name is invalid.");
      }

      const authorized = await postJson({
        apiUrl,
        body: {
          roomName: documentName,
          token,
        },
        path: "/folio-collab-rooms/authorize",
        schema: authorizeResponseSchema,
      });

      if (
        authorized.roomName !== documentName ||
        authorized.roomId !== requestedRoomId
      ) {
        panic("Collaboration token does not match the room.");
      }

      cancelRoomCleanup(documentName);
      try {
        const tokenState = upsertRoomToken({
          canEdit: authorized.canEdit,
          generation: authorized.generation,
          roomId: authorized.roomId,
          roomName: authorized.roomName,
          token,
          tokenExpiresAt: authorized.tokenExpiresAt,
        });
        tokenState.activeConnections += 1;
        try {
          await ensureRoomHeartbeat(tokenState);
        } catch (error) {
          tokenState.activeConnections -= 1;
          throw error;
        }
        connectionConfig.readOnly = !authorized.canEdit;
        const managedConnection = managedConnectionsByRequest.get(request);
        if (managedConnection === undefined) {
          panic("Collaboration socket ownership is missing.");
        }
        managedConnection.roomConnectionCounts.set(
          documentName,
          (managedConnection.roomConnectionCounts.get(documentName) ?? 0) + 1,
        );
        managedConnection.socketIds.add(socketId);
        managedConnectionsBySocketId.set(socketId, managedConnection);
        tokenStatesBySocketId.set(socketId, tokenState);

        return {
          join: { released: false },
          roomId: authorized.roomId,
          tokenState,
          userId: authorized.userId,
          userName: authorized.userName,
        };
      } catch (error) {
        clearRoomTokens(documentName);
        throw error;
      }
    },
    async onDisconnect({ context, documentName, socketId }) {
      await Promise.resolve();
      releaseRoomJoin({ context, documentName, socketId });
    },
    async beforeHandleAwareness({ context, document, states }) {
      if (context === undefined) {
        return;
      }
      for (const [clientId, state] of states) {
        const existingUserId = readPresenceUserId(
          document.awareness.getStates().get(clientId),
        );
        if (existingUserId !== null && existingUserId !== context.userId) {
          states.delete(clientId);
          logCollabEvent({
            event: "awareness_identity_conflict",
            generation: context.tokenState.generation,
            level: "error",
            roomId: context.roomId,
          });
          continue;
        }
        state["user"] = {
          color: presenceColorFromUserId(context.userId),
          id: context.userId,
          image: null,
          name: context.userName,
        };
      }
      await Promise.resolve();
    },
    async onLoadDocument({ context, document, documentName }) {
      cancelRoomCleanup(documentName);
      const result = await postJson({
        apiUrl,
        authorizationToken: serviceToken,
        body: {
          roomId: context.roomId,
        },
        path: "/folio-collab-rooms/snapshot/load",
        schema: folioCollabSnapshotLoadResponseSchema,
      });
      switch (result.loadOutcome) {
        case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx:
          closeResetRoomConnections({
            roomName: documentName,
            resetGeneration: result.resetGeneration,
          });
          logCollabEvent({
            event: "snapshot_refused_rematerialization",
            generation: result.resetGeneration,
            level: "warn",
            roomId: context.roomId,
          });
          return;
        case FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded:
          break;
        default: {
          result satisfies never;
          panic("Unhandled snapshot load outcome");
        }
      }
      context.tokenState.generation = result.generation;
      documentSnapshots.set(document, {
        generation: result.generation,
        roomId: context.roomId,
        snapshotRevision: result.snapshotRevision,
      });

      if (!result.snapshotBase64) {
        return;
      }

      applyUpdate(document, Buffer.from(result.snapshotBase64, "base64"));
    },
    async onStateless({ connection, document, payload }) {
      const parsed = v.safeParse(flushRequestSchema, payload);
      if (!parsed.success) {
        return;
      }
      const snapshotRevision = await queueRoomSnapshotStore(document);
      connection.sendStateless(
        JSON.stringify({
          requestId: parsed.output.requestId,
          snapshotRevision,
          type: FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
        }),
      );
    },
    async onStoreDocument(payload) {
      const { document } = payload;
      try {
        await queueRoomSnapshotStore(document);
      } catch (error) {
        if (snapshotStoreFailureOutcome(error) === "retired") {
          settleSnapshotStore(document);
          throw error;
        }
        const failedAttempts =
          (pendingSnapshotStores.get(document)?.failedAttempts ?? 0) + 1;
        const retryInMs = scheduleSnapshotStoreRetry(payload, failedAttempts);
        logCollabEvent({
          attempt: failedAttempts,
          event: "snapshot_store_failed",
          level: "error",
          retryInMs,
          roomId: snapshotRoomIdForLog(document),
          status:
            error instanceof FetchBoundaryError ? (error.status ?? null) : null,
        });
        // Returning lets the coordination extension release its store lock;
        // the pending store keeps the document loaded until a retry lands.
      }
    },
  });

  type HocuspocusClientConnection = ReturnType<
    typeof hocuspocus.handleConnection
  >;

  const clientConnections = new Map<
    Peer,
    {
      connection: HocuspocusClientConnection;
      managedConnection: ManagedConnection;
      socket: ManagedWebSocketLike;
    }
  >();

  const webSocketAdapter = crossws({
    hooks: {
      close(peer, event) {
        const client = clientConnections.get(peer);
        if (!client) {
          return;
        }

        client.socket.markClosed();
        client.connection.handleClose({
          code: event.code ?? 1000,
          reason: event.reason ?? "",
        });
        managedConnections.delete(client.managedConnection);
        managedConnectionsByRequest.delete(peer.request);
        for (const socketId of client.managedConnection.socketIds) {
          managedConnectionsBySocketId.delete(socketId);
          tokenStatesBySocketId.delete(socketId);
        }
        clientConnections.delete(peer);
      },
      message(peer, message) {
        clientConnections
          .get(peer)
          ?.connection.handleMessage(message.uint8Array());
      },
      open(peer) {
        if (!redisReady) {
          peer.close(
            FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE,
            REDIS_RETRY_CLOSE_REASON,
          );
          return;
        }

        const socket = createManagedWebSocket(peer);
        const managedConnection: ManagedConnection = {
          roomConnectionCounts: new Map(),
          socket,
          socketIds: new Set(),
        };
        managedConnections.add(managedConnection);
        managedConnectionsByRequest.set(peer.request, managedConnection);
        const connection = hocuspocus.handleConnection(socket, peer.request);
        clientConnections.set(peer, { connection, managedConnection, socket });
      },
    },
  });

  const server = Bun.serve({
    fetch(request, bunServer): Promise<Response | undefined> | Response {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!redisReady) {
          return new Response("Collaboration coordination unavailable", {
            status: 503,
          });
        }

        return webSocketAdapter.handleUpgrade(request, bunServer);
      }

      if (new URL(request.url).pathname === "/readyz") {
        return new Response(redisReady ? "ready" : "unavailable", {
          status: redisReady ? 200 : 503,
        });
      }

      return new Response("Welcome to Hocuspocus!", {
        headers: { "Content-Type": "text/plain" },
      });
    },
    hostname,
    port,
    websocket: webSocketAdapter.websocket,
  });

  const serverPort = server.port;
  if (serverPort === undefined) {
    panic("Collaboration server did not expose a listening port.");
  }

  await hocuspocus.hooks("onListen", {
    configuration: hocuspocus.configuration,
    instance: hocuspocus,
    port: serverPort,
  });

  const destroy = async () => {
    shuttingDown = true;
    for (const tokenState of roomHeartbeatStates.keys()) {
      clearRoomHeartbeat(tokenState);
    }
    for (const state of tokenStates.values()) {
      clearRoomTokenRefresh(state);
    }
    tokenStates.clear();
    for (const timer of roomCleanupTimers.values()) {
      clearTimeout(timer);
    }
    roomCleanupTimers.clear();

    await server.stop(true);

    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const documentsUnloaded = new Promise<void>((resolve) => {
      hocuspocus.configuration.extensions.push({
        async afterUnloadDocument({ instance }) {
          if (instance.getDocumentsCount() === 0) {
            resolve();
          }

          await Promise.resolve();
        },
      });

      if (hocuspocus.getDocumentsCount() === 0) {
        resolve();
      }

      hocuspocus.closeConnections();
      hocuspocus.flushPendingStores();
      for (const [document, pending] of pendingSnapshotStores) {
        if (pending.timer === null) {
          // A retry is running; a failure reschedules it immediately.
          continue;
        }
        shutdownFlushedDocuments.add(document);
        retrySnapshotStore(document);
      }
    });

    const drained = await Promise.race([
      documentsUnloaded.then(() => true),
      new Promise<boolean>((resolve) => {
        drainTimeout = setTimeout(() => resolve(false), shutdownDrainTimeoutMs);
      }),
    ]);
    if (drainTimeout !== undefined) {
      clearTimeout(drainTimeout);
    }
    if (!drained) {
      logCollabEvent({ event: "shutdown_drain_timeout", level: "error" });
    }
    snapshotStoreRetriesClosed = true;
    for (const [document, pending] of pendingSnapshotStores) {
      if (pending.timer !== null) {
        clearTimeout(pending.timer);
      }
      logCollabEvent({
        event: "snapshot_store_abandoned",
        level: "error",
        roomId: snapshotRoomIdForLog(document),
      });
    }
    pendingSnapshotStores.clear();

    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
  };

  return {
    destroy,
    hocuspocus,
    httpUrl: `http://127.0.0.1:${serverPort}`,
    isReady: () => redisReady,
    port: serverPort,
    server,
    websocketUrl: `ws://127.0.0.1:${serverPort}`,
  };
};
