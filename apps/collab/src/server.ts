import { Hocuspocus } from "@hocuspocus/server";
import type { WebSocketLike } from "@hocuspocus/server";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/bun";
import * as v from "valibot";
import { applyUpdate, encodeStateAsUpdate } from "yjs";

type CollabAuthContext = {
  canEdit: boolean;
  sessionId: string;
  token: string;
  userId: string;
  workspaceId: string;
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
  userId: v.string(),
  workspaceId: v.string(),
});

const loadSnapshotResponseSchema = v.strictObject({
  snapshotBase64: v.nullable(v.string()),
});

const storeSnapshotResponseSchema = v.strictObject({
  storedAt: v.string(),
});

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
    throw new Error(`Stella API request failed: ${response.status}`);
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
  const hocuspocus = new Hocuspocus<CollabAuthContext>({
    debounce: debounceMs,
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
        throw new Error("Collaboration token does not match the room.");
      }

      return {
        canEdit: authorized.canEdit,
        sessionId: authorized.sessionId,
        token,
        userId: authorized.userId,
        workspaceId: authorized.workspaceId,
      };
    },
    async onLoadDocument({ context, document }) {
      const result = await postJson({
        apiUrl,
        body: {
          sessionId: context.sessionId,
          token: context.token,
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

      await postJson({
        apiUrl,
        body: {
          sessionId: context.sessionId,
          snapshotBase64: Buffer.from(encodeStateAsUpdate(document)).toString(
            "base64",
          ),
          token: context.token,
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
    throw new Error("Collaboration server did not expose a listening port.");
  }

  await hocuspocus.hooks("onListen", {
    configuration: hocuspocus.configuration,
    instance: hocuspocus,
    port: serverPort,
  });

  const destroy = async () => {
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
