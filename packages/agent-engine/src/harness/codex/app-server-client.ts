import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { ProtocolLog } from "../../protocol-log";
import {
  type HarnessProcessDeadlines,
  startHarnessProcess,
} from "../harness-process";
import type { HarnessSpawnError } from "../process-tree";
import type { Detached, HarnessExit } from "../turn-lifecycle";
import {
  type CodexClientNotificationMethod,
  type CodexClientRequestMethod,
  type CodexRequestId,
  JsonRpcMessageSchema,
} from "./protocol";

/**
 * JSON-RPC over the stdio of one `codex app-server` process: one JSON object
 * per line in each direction. The shared harness process owns the process
 * and bounds every wait on it; this client correlates JSON-RPC ids.
 */

class AppServerRequestError extends TaggedError("AppServerRequestError")<{
  reason: "rejected" | "closed" | "timed_out";
  code: number | null;
  message: string;
}> {}

export type AppServerHandlers = {
  notification: (method: string, params: unknown) => void;
  request: (id: CodexRequestId, method: string, params: unknown) => void;
  /** The peer wrote something that is not a protocol message. */
  violation: (message: string) => void;
  exit: (exit: HarnessExit) => void;
};

export type AppServerLaunch = {
  executable: string;
  args: readonly string[];
};

type StartAppServerOptions = {
  launch: AppServerLaunch;
  protocolLog: ProtocolLog;
  detached: Detached;
  deadlines: HarnessProcessDeadlines;
  cwd: string;
  env: Readonly<Record<string, string>>;
  handlers: AppServerHandlers;
};

/**
 * Requests that may wait longer than the usual deadline. Initialize covers
 * the CLI's first launch (an antivirus scan, a busy computer); starting or
 * resuming a thread waits for its MCP servers, stella's among them.
 */
const SLOW_REQUEST_MS: Partial<Record<CodexClientRequestMethod, number>> = {
  initialize: 2 * 60_000,
  "thread/start": 90_000,
  "thread/resume": 90_000,
};

export type AppServerClient = {
  request: (
    method: CodexClientRequestMethod,
    params: unknown,
  ) => Promise<Result<unknown, AppServerRequestError>>;
  notify: (method: CodexClientNotificationMethod, params?: unknown) => void;
  respond: (id: CodexRequestId, result: unknown) => void;
  respondError: (id: CodexRequestId, code: number, message: string) => void;
  /** The server process's id. */
  pid: number;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<HarnessExit>;
  /** Ends stdin, which asks the server to flush its state and exit. */
  closeInput: () => void;
  /** SIGTERM, then SIGKILL once the termination deadline passes. */
  kill: () => Promise<HarnessExit>;
};

export const startAppServer = ({
  launch,
  protocolLog,
  detached,
  deadlines,
  cwd,
  env,
  handlers,
}: StartAppServerOptions): Result<AppServerClient, HarnessSpawnError> => {
  const state = { nextId: 1 };

  const dispatch = (value: unknown) => {
    const parsed = v.safeParse(JsonRpcMessageSchema, value);
    if (!parsed.success) {
      handlers.violation("The harness wrote a message that is not JSON-RPC.");
      return;
    }
    const message = parsed.output;
    if ("method" in message && "id" in message) {
      handlers.request(message.id, message.method, message.params);
      return;
    }
    if ("method" in message) {
      handlers.notification(message.method, message.params);
      return;
    }
    const answered = server.settle(
      message.id,
      "error" in message
        ? Result.err(
            new AppServerRequestError({
              reason: "rejected",
              code: message.error.code,
              message: message.error.message,
            }),
          )
        : Result.ok(message.result),
    );
    if (!answered) {
      handlers.violation("The harness answered a request that was not sent.");
    }
  };

  const started = startHarnessProcess<CodexRequestId, AppServerRequestError>({
    command: [launch.executable, ...launch.args],
    cwd,
    env,
    detached,
    deadlines,
    name: "codex-app-server",
    protocol: { channel: "codex", log: protocolLog },
    unanswered: (reason, message) =>
      new AppServerRequestError({ reason, code: null, message }),
    message: dispatch,
    violation: handlers.violation,
    exit: handlers.exit,
  });
  if (Result.isError(started)) {
    return started;
  }
  const server = started.value;

  return Result.ok({
    pid: server.pid,
    request: async (method, params) => {
      const id = state.nextId;
      state.nextId += 1;
      return await server.request(
        id,
        method,
        { id, method, params },
        SLOW_REQUEST_MS[method],
      );
    },
    notify: (method, params) => {
      server.write(params === undefined ? { method } : { method, params });
    },
    respond: (id, result) => {
      server.write({ id, result });
    },
    respondError: (id, code, message) => {
      server.write({ id, error: { code, message } });
    },
    exited: server.exited,
    closeInput: server.closeInput,
    kill: server.kill,
  });
};
