import { Hocuspocus } from "@hocuspocus/server";
import type { WebSocketLike } from "@hocuspocus/server";
import { panic } from "better-result";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/bun";
import * as v from "valibot";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

import { FetchBoundaryError } from "@stll/errors";

import { isSecureStellaApiUrl } from "./env-schema";

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

type CreateCollabServerOptions = {
  apiUrl: string;
  debounceMs?: number;
  hostname?: string;
  maxDebounceMs?: number;
  port: number;
};

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
  body,
  path,
  schema,
}: {
  apiUrl: string;
  body: Record<string, unknown>;
  path: string;
  schema: TSchema;
}): Promise<v.InferOutput<TSchema>> => {
  const response = await fetch(`${apiUrl}/v1${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
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

export const createCollabServer = async ({
  apiUrl,
  debounceMs = 2000,
  hostname = "0.0.0.0",
  maxDebounceMs = 10_000,
  port,
}: CreateCollabServerOptions) => {
  if (!isSecureStellaApiUrl(apiUrl)) {
    panic(
      "STELLA_API_URL must use HTTPS unless it targets a loopback address.",
    );
  }

  const tokenStates = new Map<string, CollabRoomTokenState>();
  const roomHeartbeatStates = new Map<string, CollabRoomHeartbeatState>();

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

  const clearRoomTokens = (roomId: string) => {
    clearRoomHeartbeat(roomId);
    for (const [token, state] of tokenStates) {
      if (state.roomId !== roomId) {
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
        hocuspocus.closeConnections(state.roomId);
        clearRoomTokens(state.roomId);
      });
    }, delayMs);
  };

  const upsertRoomToken = ({
    canEdit,
    generation,
    roomId,
    token,
    tokenExpiresAt,
  }: {
    canEdit: boolean;
    generation: number;
    roomId: string;
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
      scheduleTokenRefresh(existing);
      return existing;
    }

    const state: CollabRoomTokenState = {
      canEdit,
      generation,
      refreshInFlight: null,
      refreshTimer: null,
      roomId,
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
          hocuspocus.closeConnections(state.roomId);
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
          hocuspocus.closeConnections(roomId);
          clearRoomTokens(roomId);
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
      clearRoomTokens(documentName);
      await Promise.resolve();
    },
    maxDebounce: maxDebounceMs,
    async onAuthenticate({ connectionConfig, documentName, token }) {
      const authorized = await postJson({
        apiUrl,
        body: {
          roomId: documentName,
          token,
        },
        path: "/folio-collab-rooms/authorize",
        schema: authorizeResponseSchema,
      });

      if (authorized.roomName !== documentName) {
        panic("Collaboration token does not match the room.");
      }

      const tokenState = upsertRoomToken({
        canEdit: authorized.canEdit,
        generation: authorized.generation,
        roomId: authorized.roomId,
        token,
        tokenExpiresAt: authorized.tokenExpiresAt,
      });
      await ensureRoomHeartbeat(tokenState);
      connectionConfig.readOnly = !authorized.canEdit;

      return {
        roomId: authorized.roomId,
        tokenState,
        userId: authorized.userId,
        workspaceId: authorized.workspaceId,
      };
    },
    async onLoadDocument({ context, document }) {
      const token = await getFreshRoomToken(context.tokenState);
      const result = await postJson({
        apiUrl,
        body: {
          roomId: context.roomId,
          token,
        },
        path: "/folio-collab-rooms/snapshot/load",
        schema: loadSnapshotResponseSchema,
      });
      context.tokenState.generation = result.generation;

      if (!result.snapshotBase64) {
        return;
      }

      applyUpdate(document, Buffer.from(result.snapshotBase64, "base64"));
    },
    async onStoreDocument({ document, lastContext: context }) {
      if (!context.tokenState.canEdit) {
        return;
      }

      const token = await getFreshRoomToken(context.tokenState);
      await postJson({
        apiUrl,
        body: {
          expectedGeneration: context.tokenState.generation,
          roomId: context.roomId,
          snapshotBase64: Buffer.from(encodeStateAsUpdate(document)).toString(
            "base64",
          ),
          token,
        },
        path: "/folio-collab-rooms/snapshot/store",
        schema: storeSnapshotResponseSchema,
      });
    },
  });

  type HocuspocusClientConnection = ReturnType<
    typeof hocuspocus.handleConnection
  >;

  const clientConnections = new WeakMap<
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
        clientConnections.delete(peer);
      },
      message(peer, message) {
        clientConnections
          .get(peer)
          ?.connection.handleMessage(message.uint8Array());
      },
      open(peer) {
        const socket = createManagedWebSocket(peer);
        const connection = hocuspocus.handleConnection(socket, peer.request);
        clientConnections.set(peer, { connection, socket });
      },
    },
  });

  const server = Bun.serve({
    fetch(request, bunServer): Promise<Response | undefined> | Response {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return webSocketAdapter.handleUpgrade(request, bunServer);
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
    for (const roomId of roomHeartbeatStates.keys()) {
      clearRoomHeartbeat(roomId);
    }
    for (const state of tokenStates.values()) {
      clearRoomTokenRefresh(state);
    }
    tokenStates.clear();

    await server.stop(true);

    await new Promise<void>((resolve) => {
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

    await hocuspocus.hooks("onDestroy", { instance: hocuspocus });
  };

  return {
    destroy,
    hocuspocus,
    httpUrl: `http://127.0.0.1:${serverPort}`,
    port: serverPort,
    server,
    websocketUrl: `ws://127.0.0.1:${serverPort}`,
  };
};
