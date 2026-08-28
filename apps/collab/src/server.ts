import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { Hocuspocus } from "@hocuspocus/server";
import type {
  Document as HocuspocusDocument,
  WebSocketLike,
} from "@hocuspocus/server";
import { panic } from "better-result";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/bun";
import RedisClient from "ioredis";
import * as v from "valibot";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import {
  FOLIO_COLLAB_REDIS_SCOPE,
  parseFolioCollabRoomName,
} from "@stll/api-contract/folio-collab";
import { FetchBoundaryError } from "@stll/errors";

import { isSecureCollabRedisUrl, isSecureStellaApiUrl } from "./env-schema";
import { logCollabEvent } from "./log";

type CollabAuthContext = {
  roomId: string;
  tokenState: CollabRoomTokenState;
  userId: string;
  workspaceId: string;
};

type CollabRoomTokenState = {
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

type CreateCollabServerBaseOptions = {
  apiUrl: string;
  serviceToken: string;
  debounceMs?: number;
  hostname?: string;
  maxDebounceMs?: number;
  port: number;
  shutdownDrainTimeoutMs?: number;
};

type CreateCollabServerOptions = CreateCollabServerBaseOptions &
  (
    | { mode: "redis"; redisUrl: string }
    | { mode?: "single-process"; redisUrl?: never }
  );

const authorizeResponseSchema = v.strictObject({
  canEdit: v.boolean(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  roomId: v.string(),
  roomName: v.string(),
  tokenExpiresAt: v.string(),
  userId: v.string(),
  workspaceId: v.string(),
});

const refreshTokenResponseSchema = v.strictObject({
  canEdit: v.boolean(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  token: v.string(),
  tokenExpiresAt: v.string(),
});

const loadSnapshotResponseSchema = v.strictObject({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  snapshotBase64: v.nullable(v.string()),
});

const storeSnapshotResponseSchema = v.strictObject({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  storedAt: v.string(),
});

const heartbeatResponseSchema = v.strictObject({
  activeAt: v.string(),
});

const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const ROOM_ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000;
const REDIS_LOCK_TIMEOUT_MS = 30_000;
const REDIS_INITIAL_SYNC_TIMEOUT_MS = 3000;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const REDIS_RETRY_CLOSE_CODE = 4503;
const REDIS_RETRY_CLOSE_REASON = "Collaboration coordination unavailable";

const parseTokenExpiresAt = (value: string) => {
  const expiresAtMs = Date.parse(value);
  if (Number.isNaN(expiresAtMs)) {
    throw new TypeError("Stella API returned an invalid token expiry.");
  }

  return expiresAtMs;
};

const tokenRefreshDelayMs = (tokenExpiresAtMs: number) => {
  const msUntilExpiry = tokenExpiresAtMs - Date.now();
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
    serviceToken,
    shutdownDrainTimeoutMs = SHUTDOWN_DRAIN_TIMEOUT_MS,
  } = options;
  const mode = options.mode ?? "single-process";
  if (!isSecureStellaApiUrl(apiUrl)) {
    panic(
      "STELLA_API_URL must use HTTPS unless it targets a loopback address.",
    );
  }

  if (options.mode === "redis" && !isSecureCollabRedisUrl(options.redisUrl)) {
    panic(
      "STELLA_COLLAB_REDIS_URL must use rediss:// unless it targets a loopback address.",
    );
  }

  let redisReady = mode === "single-process";
  let redisUnavailableLogged = false;
  let shuttingDown = false;
  const managedSockets = new Set<ManagedWebSocketLike>();
  const closeConnectionsForRedisLoss = () => {
    for (const socket of managedSockets) {
      socket.close(REDIS_RETRY_CLOSE_CODE, REDIS_RETRY_CLOSE_REASON);
    }
  };
  const redisExtension =
    options.mode === "redis"
      ? new RedisExtension({
          awaitInitialSyncTimeout: REDIS_INITIAL_SYNC_TIMEOUT_MS,
          createClient: () => new RedisClient(options.redisUrl),
          lockTimeout: REDIS_LOCK_TIMEOUT_MS,
          prefix: FOLIO_COLLAB_REDIS_SCOPE,
        })
      : null;

  const updateRedisReadiness = () => {
    if (redisExtension === null || shuttingDown) {
      return;
    }

    const nextReady =
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

    closeConnectionsForRedisLoss();
  };

  const markRedisUnavailable = (
    transport: "publish" | "subscribe",
    signal: "close" | "end" | "error",
  ) => {
    if (shuttingDown) {
      return;
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
      closeConnectionsForRedisLoss();
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
  }

  const tokenStates = new Map<string, CollabRoomTokenState>();
  const roomHeartbeatStates = new Map<string, CollabRoomHeartbeatState>();
  const documentSnapshots = new WeakMap<
    HocuspocusDocument,
    { generation: number; roomId: string }
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

  const clearRoomHeartbeat = (roomId: string) => {
    const state = roomHeartbeatStates.get(roomId);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }
    roomHeartbeatStates.delete(roomId);
  };

  const clearRoomTokens = (roomName: string) => {
    const roomId = parseFolioCollabRoomName(roomName);
    if (roomId !== null) {
      clearRoomHeartbeat(roomId);
    }
    for (const [token, state] of tokenStates) {
      if (state.roomName !== roomName) {
        continue;
      }
      clearRoomTokenRefresh(state);
      tokenStates.delete(token);
    }
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
    if (state.tokenExpiresAtMs - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
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

  const scheduleRoomHeartbeat = (roomId: string) => {
    const state = roomHeartbeatStates.get(roomId);
    if (!state || state.timer) {
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      const request = heartbeatRoom(state.tokenState);
      state.inFlight = request;
      void request
        .then(() => {
          if (roomHeartbeatStates.get(roomId) === state) {
            state.inFlight = null;
            scheduleRoomHeartbeat(roomId);
          }
          return undefined;
        })
        .catch(() => {
          hocuspocus.closeConnections(state.tokenState.roomName);
          clearRoomTokens(state.tokenState.roomName);
        });
    }, ROOM_ACTIVITY_HEARTBEAT_INTERVAL_MS);
  };

  const ensureRoomHeartbeat = async (tokenState: CollabRoomTokenState) => {
    const existing = roomHeartbeatStates.get(tokenState.roomId);
    if (existing) {
      existing.tokenState = tokenState;
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
    roomHeartbeatStates.set(tokenState.roomId, state);
    const request = heartbeatRoom(tokenState);
    state.inFlight = request;
    try {
      await request;
      state.inFlight = null;
      scheduleRoomHeartbeat(tokenState.roomId);
    } catch (error) {
      clearRoomHeartbeat(tokenState.roomId);
      throw error;
    }
  };

  const hocuspocus = new Hocuspocus<CollabAuthContext>({
    debounce: debounceMs,
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
    async onAuthenticate({ connectionConfig, documentName, token }) {
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
      const tokenState = upsertRoomToken({
        canEdit: authorized.canEdit,
        generation: authorized.generation,
        roomId: authorized.roomId,
        roomName: authorized.roomName,
        token,
        tokenExpiresAt: authorized.tokenExpiresAt,
      });
      try {
        await ensureRoomHeartbeat(tokenState);
      } catch (error) {
        clearRoomTokens(documentName);
        throw error;
      }
      connectionConfig.readOnly = !authorized.canEdit;

      return {
        roomId: authorized.roomId,
        tokenState,
        userId: authorized.userId,
        workspaceId: authorized.workspaceId,
      };
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
        schema: loadSnapshotResponseSchema,
      });
      context.tokenState.generation = result.generation;
      documentSnapshots.set(document, {
        generation: result.generation,
        roomId: context.roomId,
      });

      if (!result.snapshotBase64) {
        return;
      }

      applyUpdate(document, Buffer.from(result.snapshotBase64, "base64"));
    },
    async onStoreDocument({ document }) {
      const snapshot = documentSnapshots.get(document);
      if (snapshot === undefined) {
        panic("Collaboration room snapshot generation is missing.");
      }

      const store = async () =>
        await postJson({
          apiUrl,
          authorizationToken: serviceToken,
          body: {
            expectedGeneration: snapshot.generation,
            roomId: snapshot.roomId,
            snapshotBase64: Buffer.from(encodeStateAsUpdate(document)).toString(
              "base64",
            ),
          },
          path: "/folio-collab-rooms/snapshot/store",
          schema: storeSnapshotResponseSchema,
        });

      try {
        await store();
        return;
      } catch (error) {
        if (!(error instanceof FetchBoundaryError) || error.status !== 409) {
          throw error;
        }
      }

      const refreshed = await postJson({
        apiUrl,
        authorizationToken: serviceToken,
        body: { roomId: snapshot.roomId },
        path: "/folio-collab-rooms/snapshot/load",
        schema: loadSnapshotResponseSchema,
      });
      snapshot.generation = refreshed.generation;
      if (refreshed.snapshotBase64 !== null) {
        applyUpdate(document, Buffer.from(refreshed.snapshotBase64, "base64"));
      }
      logCollabEvent({
        event: "snapshot_generation_refreshed",
        generation: refreshed.generation,
        level: "info",
        roomId: snapshot.roomId,
      });
      await store();
    },
  });

  type HocuspocusClientConnection = ReturnType<
    typeof hocuspocus.handleConnection
  >;

  const clientConnections = new Map<
    Peer,
    { connection: HocuspocusClientConnection; socket: ManagedWebSocketLike }
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
        managedSockets.delete(client.socket);
        clientConnections.delete(peer);
      },
      message(peer, message) {
        clientConnections
          .get(peer)
          ?.connection.handleMessage(message.uint8Array());
      },
      open(peer) {
        if (!redisReady) {
          peer.close(REDIS_RETRY_CLOSE_CODE, REDIS_RETRY_CLOSE_REASON);
          return;
        }

        const socket = createManagedWebSocket(peer);
        const connection = hocuspocus.handleConnection(socket, peer.request);
        managedSockets.add(socket);
        clientConnections.set(peer, { connection, socket });
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
    for (const roomId of roomHeartbeatStates.keys()) {
      clearRoomHeartbeat(roomId);
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
