import { panic, Result } from "better-result";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_EXTENSION_MESSAGE_SOURCE,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlResult,
  type BrowserDesktopRequest,
  type BrowserObservedTab,
  parseBrowserDesktopResponse,
} from "@stll/api-contract/browser-control";

import { type LocalBrowserResult, localBrowserResult } from "./local-result";

/**
 * The holder's end of the link to the member's Chrome. Chrome starts the
 * native messaging host (`native-host.ts`) for the stella extension; the host
 * connects here over a Unix socket in the holder's private runtime folder,
 * presents the secret the holder wrote beside it, and relays lines both
 * ways. Commands go to the extension and results come back on this
 * computer only: nothing here talks to a network.
 *
 * One host at a time: a second one (another Chrome profile) is refused while
 * the first is connected.
 */

/** The file the host reads the bridge secret from, mode 0600. */
const BROWSER_BRIDGE_SECRET_FILE = "browser.secret";

const SECRET_BYTES = 32;
/** A snapshot result is far below this; a longer line drops the host. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5000;

/** The host's first line: the hex secret from `BROWSER_BRIDGE_SECRET_FILE`. */
export const browserBridgeAuthLine = (secret: string): string => `${secret}\n`;

type BrowserBridgeStatus =
  /** No host is connected: Chrome is closed or the member has not allowed it. */
  | { type: "absent" }
  /** A host connected; the extension has not said which protocol it speaks. */
  | { type: "waiting" }
  | { type: "ready"; protocolVersion: number };

type BrowserBridgeRequest = {
  command: BrowserControlCommand;
  /** The chat the agent runs in; the extension keeps one tab per chat. */
  controllerId: string;
  observedTab: BrowserObservedTab | null;
  toolCallId: string;
  /** The run; the extension's per-turn budgets count by it. */
  turnId: string;
};

/** Which command to stop: the chat's controller and its run. */
type BrowserBridgeCancel = { controllerId: string; turnId: string };

export type BrowserBridge = {
  readonly endpoint: string;
  readonly secretFile: string;
  status: () => BrowserBridgeStatus;
  /** Sends one command and waits for its result, a timeout, or `signal`. */
  request: (
    request: BrowserBridgeRequest,
    signal: AbortSignal,
  ) => Promise<LocalBrowserResult>;
  /** Stops the run's queued or running command in the extension. */
  cancel: (run: BrowserBridgeCancel) => void;
  stop: () => Promise<void>;
};

export const browserBridgeError = (
  code: BrowserControlErrorCode,
  message: string,
): BrowserControlResult => ({
  code,
  message: message.slice(0, BROWSER_CONTROL_LIMITS.errorMessageChars),
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
});

const NOT_CONNECTED =
  "stella cannot reach Chrome. Ask the member to open Chrome, open the stella extension and choose Use with stella desktop, then try again.";

const secretsMatch = (presented: string, held: string) => {
  const left = Buffer.from(presented);
  const right = Buffer.from(held);
  return left.length === right.length && timingSafeEqual(left, right);
};

const parseJson = (line: string): unknown => {
  const parsed = Result.try((): unknown => JSON.parse(line));
  return Result.isOk(parsed) ? parsed.value : undefined;
};

/** Calls `onLine` with each complete line; false once a line is too long. */
const lineSplitter = (onLine: (line: string) => void) => {
  const decoder = new TextDecoder();
  let buffer = "";
  return (bytes: Uint8Array): boolean => {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim() !== "") {
        onLine(line);
      }
    }
    return buffer.length <= MAX_LINE_BYTES;
  };
};

/** Feeds a host connection's lines to `onLine`; a too-long line drops it. */
const wireHostSocket = (
  socket: net.Socket,
  {
    log,
    onLine,
  }: { log: (line: string) => void; onLine: (line: string) => void },
) => {
  const read = lineSplitter(onLine);
  socket.on("data", (bytes: Uint8Array) => {
    if (!read(bytes)) {
      log("dropped a browser host whose line was too long");
      socket.destroy();
    }
  });
  socket.on("error", () => {
    socket.destroy();
  });
};

type Host = {
  socket: net.Socket;
  status: "authenticating" | "waiting" | "ready";
  protocolVersion: number | null;
};

type StartBrowserBridgeOptions = {
  /** The holder's private folder; the secret file goes here. */
  dir: string;
  /** The socket path, in the same private runtime folder as the holder's. */
  endpoint: string;
  /** How long a command may take before it is reported as unobserved. */
  timeoutMs: number;
  log: (line: string) => void;
};

type AwaitResultOptions = {
  /** Each command's settle, by request id, until its result arrives. */
  pending: Map<string, (result: BrowserControlResult) => void>;
  requestId: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Asks the extension to stop the command. */
  cancel: () => void;
  /** Sends the command, once its result is waited for. */
  dispatch: () => void;
};

/** One command's result: the extension's, or a timeout or stop here. */
const awaitResult = async ({
  cancel,
  dispatch,
  pending,
  requestId,
  signal,
  timeoutMs,
}: AwaitResultOptions): Promise<BrowserControlResult> => {
  const { promise, resolve } = Promise.withResolvers<BrowserControlResult>();
  const settle = (result: BrowserControlResult) => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    pending.delete(requestId);
    resolve(result);
  };
  const timer = setTimeout(() => {
    cancel();
    settle(
      browserBridgeError(
        BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
        "Chrome did not report back in time. Take a snapshot before retrying.",
      ),
    );
  }, timeoutMs);
  const onAbort = () => {
    cancel();
    settle(
      browserBridgeError(
        BROWSER_CONTROL_ERROR_CODE.cancelled,
        "The run stopped before Chrome reported back.",
      ),
    );
  };
  if (signal.aborted) {
    onAbort();
    return await promise;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  pending.set(requestId, settle);
  dispatch();
  return await promise;
};

/** Stops listening, then removes the socket and the secret. */
const closeServer = async (server: net.Server, files: readonly string[]) => {
  await new Promise<null>((resolve) => {
    server.close(() => {
      resolve(null);
    });
  });
  for (const file of files) {
    rmSync(file, { force: true });
  }
};

const listen = async (server: net.Server, endpoint: string) =>
  await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const failed = (error: NodeJS.ErrnoException) => {
      resolve(error);
    };
    server.once("error", failed);
    server.listen(endpoint, () => {
      server.off("error", failed);
      resolve(null);
    });
  });

/** Writes the secret readable only by this user, replacing any earlier one. */
const writeSecretFile = (
  secretFile: string,
  secret: string,
): Result<void, { message: string }> => {
  const temporary = `${secretFile}.${process.pid}.tmp`;
  const written = Result.try(() => {
    writeFileSync(temporary, secret, { mode: 0o600 });
    renameSync(temporary, secretFile);
  });
  if (Result.isError(written)) {
    rmSync(temporary, { force: true });
    return Result.err({ message: "the secret file could not be written" });
  }
  return Result.ok(undefined);
};

export const startBrowserBridge = async ({
  dir,
  endpoint,
  log,
  timeoutMs,
}: StartBrowserBridgeOptions): Promise<
  Result<BrowserBridge, { message: string }>
> => {
  const server = net.createServer();
  // The holder owns its runtime folder, so a socket file left here is a
  // crashed holder's.
  rmSync(endpoint, { force: true });
  const failed = await listen(server, endpoint);
  if (failed !== null) {
    return Result.err({ message: failed.code ?? "listen failed" });
  }
  const secret = randomBytes(SECRET_BYTES).toString("hex");
  const secretFile = path.join(dir, BROWSER_BRIDGE_SECRET_FILE);
  const written = writeSecretFile(secretFile, secret);
  if (Result.isError(written)) {
    // Without the secret file no host can connect: the holder goes on
    // without browser tools.
    await closeServer(server, [endpoint]);
    return written;
  }

  let host: Host | null = null;
  /** Each command's settle, by request id, until its result arrives. */
  const pending = new Map<string, (result: BrowserControlResult) => void>();

  const failAll = (result: BrowserControlResult) => {
    for (const [requestId, settle] of pending) {
      pending.delete(requestId);
      settle(result);
    }
  };

  const write = (socket: net.Socket, message: BrowserDesktopRequest) => {
    socket.write(`${JSON.stringify(message)}\n`);
  };

  const onHostLine = (connected: Host, line: string) => {
    if (connected.status === "authenticating") {
      if (!secretsMatch(line.trim(), secret)) {
        log("refused a browser host that did not present the secret");
        connected.socket.destroy();
        return;
      }
      if (host !== null) {
        log("refused a second browser host");
        connected.socket.destroy();
        return;
      }
      host = connected;
      connected.status = "waiting";
      write(connected.socket, {
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
        type: "hello",
      });
      return;
    }
    const response = parseBrowserDesktopResponse(parseJson(line));
    if (response === null) {
      log("ignored a browser host line outside the protocol");
      return;
    }
    switch (response.type) {
      case "hello":
        connected.status = "ready";
        connected.protocolVersion = response.protocolVersion;
        log(
          `the browser extension speaks protocol ${response.protocolVersion}`,
        );
        return;
      case "command-result": {
        pending.get(response.requestId)?.(response.result);
        return;
      }
      default:
        response satisfies never;
        panic("Unhandled browser host response");
    }
  };

  server.on("connection", (socket) => {
    const connected: Host = {
      protocolVersion: null,
      socket,
      status: "authenticating",
    };
    const authTimer = setTimeout(() => {
      if (connected.status === "authenticating") {
        socket.destroy();
      }
    }, AUTH_TIMEOUT_MS);
    wireHostSocket(socket, {
      log,
      onLine: (line) => {
        onHostLine(connected, line);
      },
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      if (host === connected) {
        host = null;
        failAll(
          browserBridgeError(
            BROWSER_CONTROL_ERROR_CODE.outcomeUnknown,
            "Chrome disconnected before the command reported back. Take a snapshot before retrying.",
          ),
        );
      }
    });
  });

  const status = (): BrowserBridgeStatus => {
    if (host === null) {
      return { type: "absent" };
    }
    return host.status === "ready" && host.protocolVersion !== null
      ? { protocolVersion: host.protocolVersion, type: "ready" }
      : { type: "waiting" };
  };

  const cancel = ({ controllerId, turnId }: BrowserBridgeCancel) => {
    if (host?.status !== "ready") {
      return;
    }
    write(host.socket, {
      controllerId,
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
      turnId,
      type: "cancel",
    });
  };

  const send = async (
    {
      command,
      controllerId,
      observedTab,
      toolCallId,
      turnId,
    }: BrowserBridgeRequest,
    signal: AbortSignal,
  ): Promise<BrowserControlResult> => {
    const current = status();
    if (current.type !== "ready") {
      return browserBridgeError(
        BROWSER_CONTROL_ERROR_CODE.disconnected,
        NOT_CONNECTED,
      );
    }
    if (current.protocolVersion !== BROWSER_CONTROL_PROTOCOL_VERSION) {
      return browserBridgeError(
        BROWSER_CONTROL_ERROR_CODE.disconnected,
        `The stella extension in Chrome speaks browser protocol ${current.protocolVersion} and stella desktop speaks ${BROWSER_CONTROL_PROTOCOL_VERSION}. Ask the member to update both, then try again.`,
      );
    }
    const socket = host?.socket;
    if (socket === undefined) {
      return browserBridgeError(
        BROWSER_CONTROL_ERROR_CODE.disconnected,
        NOT_CONNECTED,
      );
    }
    const requestId = crypto.randomUUID();
    return await awaitResult({
      cancel: () => {
        cancel({ controllerId, turnId });
      },
      dispatch: () => {
        write(socket, {
          command,
          controllerId,
          observedTab,
          protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
          requestId,
          source: BROWSER_EXTENSION_MESSAGE_SOURCE.desktop,
          toolCallId,
          turnId,
          type: "command",
        });
      },
      pending,
      requestId,
      signal,
      timeoutMs,
    });
  };

  return Result.ok({
    endpoint,
    secretFile,
    status,
    request: async (request, signal) =>
      localBrowserResult(await send(request, signal)),
    cancel,
    stop: async () => {
      failAll(
        browserBridgeError(
          BROWSER_CONTROL_ERROR_CODE.disconnected,
          "stella desktop stopped before Chrome reported back.",
        ),
      );
      host?.socket.destroy();
      host = null;
      await closeServer(server, [endpoint, secretFile]);
    },
  });
};
