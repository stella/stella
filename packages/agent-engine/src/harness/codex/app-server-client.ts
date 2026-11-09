import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  type HarnessProcessDeadlines,
  startHarnessProcess,
} from "../harness-process";
import type { HarnessSpawnError } from "../process-tree";
import type { Detached, HarnessExit } from "../turn-lifecycle";
import { type CodexRequestId, JsonRpcMessageSchema } from "./protocol";

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
  detached: Detached;
  deadlines: HarnessProcessDeadlines;
  cwd: string;
  env: Readonly<Record<string, string>>;
  handlers: AppServerHandlers;
};

/** A request's answer as the server wrote it. */
type AppServerAnswer = Result<unknown, AppServerRequestError>;

export type AppServerClient = {
  /**
   * Sends a request and settles with its answer. `onAnswer` sees the
   * server's answer as it is read, before any message written after it is
   * dispatched; an awaited result only arrives after them.
   */
  request: (
    method: string,
    params: unknown,
    onAnswer?: (answer: AppServerAnswer) => void,
  ) => Promise<AppServerAnswer>;
  notify: (method: string, params?: unknown) => void;
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
  detached,
  deadlines,
  cwd,
  env,
  handlers,
}: StartAppServerOptions): Result<AppServerClient, HarnessSpawnError> => {
  const state = { nextId: 1 };
  const answerHooks = new Map<
    CodexRequestId,
    (answer: AppServerAnswer) => void
  >();

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
    const answer: AppServerAnswer =
      "error" in message
        ? Result.err(
            new AppServerRequestError({
              reason: "rejected",
              code: message.error.code,
              message: message.error.message,
            }),
          )
        : Result.ok(message.result);
    const hook = answerHooks.get(message.id);
    answerHooks.delete(message.id);
    hook?.(answer);
    const answered = server.settle(message.id, answer);
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
    request: async (method, params, onAnswer) => {
      const id = state.nextId;
      state.nextId += 1;
      if (onAnswer !== undefined) {
        answerHooks.set(id, onAnswer);
      }
      const answer = await server.request(id, method, { id, method, params });
      // Unanswered (timed out, closed): the hook hears it here instead.
      if (answerHooks.delete(id)) {
        onAnswer?.(answer);
      }
      return answer;
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
