import { Hocuspocus } from "@hocuspocus/server";
import type { WebSocketLike } from "@hocuspocus/server";
import { panic, TaggedError } from "better-result";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/bun";
import * as v from "valibot";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

/**
 * HTTP/network failure when calling the Stella API from the collaboration
 * server. Carries the URL, status, and statusText for structured logging.
 */
export class FetchBoundaryError extends TaggedError("FetchBoundaryError")<{
  url: string;
  status?: number;
  statusText?: string;
  body?: string;
  message: string;
  cause?: unknown;
}>() {}

type CollabAuthContext = {
  canEdit: boolean;
  sessionId: string;
  tokenState: CollabSessionTokenState;
  userId: string;
  workspaceId: string;
};

type CollabSessionTokenState = {
  refreshInFlight: Promise<string> | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  sessionId: string;
  token: string;
  tokenExpiresAtMs: number;
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
  roomName: v.string(),
  sessionId: v.string(),
  tokenExpiresAt: v.string(),
  userId: v.string(),
  workspaceId: v.string(),
});

const refreshTokenResponseSchema = v.strictObject({
  token: v.string(),
  tokenExpiresAt: v.string(),
});

const loadSnapshotResponseSchema = v.strictObject({
  snapshotBase64: v.nullable(v.string()),
});

const storeSnapshotResponseSchema = v.strictObject({
  storedAt: v.string(),
});

const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MS = 1000;

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
  const sessionTokens = new Map<string, CollabSessionTokenState>();

  const clearSessionTokenRefresh = (state: CollabSessionTokenState) => {
    if (!state.refreshTimer) {
      return;
    }

    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  };

  const clearSessionToken = (sessionId: string) => {
    const state = sessionTokens.get(sessionId);
    if (!state) {
      return;
    }

    clearSessionTokenRefresh(state);
    sessionTokens.delete(sessionId);
  };

  const scheduleTokenRefresh = (
    state: CollabSessionTokenState,
    delayMs = tokenRefreshDelayMs(state.tokenExpiresAtMs),
  ) => {
    clearSessionTokenRefresh(state);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      void refreshSessionToken(state).catch(() => {
        const retryDelayMs = Math.min(
          TOKEN_REFRESH_RETRY_MS,
          Math.max(0, state.tokenExpiresAtMs - Date.now()),
        );

        if (retryDelayMs > 0 && sessionTokens.get(state.sessionId) === state) {
          scheduleTokenRefresh(state, retryDelayMs);
        }
      });
    }, delayMs);
  };

  const upsertSessionToken = ({
    sessionId,
    token,
    tokenExpiresAt,
  }: {
    sessionId: string;
    token: string;
    tokenExpiresAt: string;
  }) => {
    const tokenExpiresAtMs = parseTokenExpiresAt(tokenExpiresAt);
    const existing = sessionTokens.get(sessionId);

    if (existing && existing.tokenExpiresAtMs >= tokenExpiresAtMs) {
      return existing;
    }

    if (existing) {
      existing.token = token;
      existing.tokenExpiresAtMs = tokenExpiresAtMs;
      scheduleTokenRefresh(existing);
      return existing;
    }

    const state: CollabSessionTokenState = {
      refreshInFlight: null,
      refreshTimer: null,
      sessionId,
      token,
      tokenExpiresAtMs,
    };
    sessionTokens.set(sessionId, state);
    scheduleTokenRefresh(state);

    return state;
  };

  const refreshSessionToken = async (state: CollabSessionTokenState) => {
    if (state.refreshInFlight) {
      return await state.refreshInFlight;
    }

    const refresh = (async () => {
      const refreshed = await postJson({
        apiUrl,
        body: {
          sessionId: state.sessionId,
          token: state.token,
        },
        path: "/folio-collab-sessions/refresh-token",
        schema: refreshTokenResponseSchema,
      });

      state.token = refreshed.token;
      state.tokenExpiresAtMs = parseTokenExpiresAt(refreshed.tokenExpiresAt);
      if (sessionTokens.get(state.sessionId) === state) {
        scheduleTokenRefresh(state);
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

  const getFreshSessionToken = async (state: CollabSessionTokenState) => {
    if (state.tokenExpiresAtMs - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
      return state.token;
    }

    return await refreshSessionToken(state);
  };

  const hocuspocus = new Hocuspocus<CollabAuthContext>({
    debounce: debounceMs,
    async afterUnloadDocument({ documentName }) {
      clearSessionToken(documentName);
      await Promise.resolve();
    },
    maxDebounce: maxDebounceMs,
    async onAuthenticate({ documentName, token }) {
      const authorized = await postJson({
        apiUrl,
        body: {
          sessionId: documentName,
          token,
        },
        path: "/folio-collab-sessions/authorize",
        schema: authorizeResponseSchema,
      });

      if (authorized.roomName !== documentName) {
        panic("Collaboration token does not match the room.");
      }

      const tokenState = upsertSessionToken({
        sessionId: authorized.sessionId,
        token,
        tokenExpiresAt: authorized.tokenExpiresAt,
      });

      return {
        canEdit: authorized.canEdit,
        sessionId: authorized.sessionId,
        tokenState,
        userId: authorized.userId,
        workspaceId: authorized.workspaceId,
      };
    },
    async onLoadDocument({ context, document }) {
      const token = await getFreshSessionToken(context.tokenState);
      const result = await postJson({
        apiUrl,
        body: {
          sessionId: context.sessionId,
          token,
        },
        path: "/folio-collab-sessions/snapshot/load",
        schema: loadSnapshotResponseSchema,
      });

      if (!result.snapshotBase64) {
        return;
      }

      applyUpdate(document, Buffer.from(result.snapshotBase64, "base64"));
    },
    async onStoreDocument({ document, lastContext: context }) {
      if (!context.canEdit) {
        return;
      }

      const token = await getFreshSessionToken(context.tokenState);
      await postJson({
        apiUrl,
        body: {
          sessionId: context.sessionId,
          snapshotBase64: Buffer.from(encodeStateAsUpdate(document)).toString(
            "base64",
          ),
          token,
        },
        path: "/folio-collab-sessions/snapshot/store",
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
    for (const state of sessionTokens.values()) {
      clearSessionTokenRefresh(state);
    }
    sessionTokens.clear();

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
