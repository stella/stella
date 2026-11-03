import type { ServerWebSocket, WebSocketHandler } from "bun";

import { DESKTOP_RUNNER_MAX_FRAME_BYTES } from "@stll/api-contract/desktop-runner";

/**
 * The owner of one upgraded socket. A route that upgrades a request passes its
 * session as the socket's data, and the server's one WebSocket handler hands
 * every socket event to it, so each socket route keeps its own state machine.
 */
export type ApiSocketSession = {
  readonly open: (socket: ApiServerWebSocket) => void;
  readonly message: (
    socket: ApiServerWebSocket,
    message: string | Buffer,
  ) => void;
  readonly pong: (socket: ApiServerWebSocket) => void;
  /** The socket's send buffer emptied after a send reported backpressure. */
  readonly drain: (socket: ApiServerWebSocket) => void;
  readonly close: (
    socket: ApiServerWebSocket,
    code: number,
    reason: string,
  ) => void;
};

export type ApiSocketData = { readonly session: ApiSocketSession };
export type ApiServerWebSocket = ServerWebSocket<ApiSocketData>;

/**
 * Seconds without any received frame before Bun closes a socket. Sessions
 * send their own pings well inside this, so it only ends a peer that stopped
 * answering them.
 */
const SOCKET_IDLE_TIMEOUT_S = 120;

/**
 * The desktop runner socket is the only socket route, so its frame limit is
 * the server's: Bun closes a socket whose frame is larger with 1009 before it
 * buffers the rest.
 */
const API_SOCKET_MAX_PAYLOAD_BYTES = DESKTOP_RUNNER_MAX_FRAME_BYTES;

export const apiWebSocketHandler: WebSocketHandler<ApiSocketData> = {
  maxPayloadLength: API_SOCKET_MAX_PAYLOAD_BYTES,
  idleTimeout: SOCKET_IDLE_TIMEOUT_S,
  // Sessions own their heartbeat, so a missed pong is theirs to act on.
  sendPings: false,
  open: (socket) => socket.data.session.open(socket),
  message: (socket, message) => socket.data.session.message(socket, message),
  pong: (socket) => socket.data.session.pong(socket),
  drain: (socket) => socket.data.session.drain(socket),
  close: (socket, code, reason) =>
    socket.data.session.close(socket, code, reason),
};
