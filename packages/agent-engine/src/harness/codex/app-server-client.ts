import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { createLineReader } from "./json-lines";
import { type CodexRequestId, JsonRpcMessageSchema } from "./protocol";

/**
 * JSON-RPC over the stdio of one `codex app-server` process: one JSON object
 * per line in each direction. The client owns the process; when it exits,
 * every pending request settles with `closed`. Every wait is bounded: a
 * request the server does not answer in time ends the process, and a process
 * that outlives its termination signal is killed outright.
 */

/** A line longer than this is refused rather than buffered without bound. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

class AppServerRequestError extends TaggedError("AppServerRequestError")<{
  reason: "rejected" | "closed" | "timed_out";
  code: number | null;
  message: string;
}> {}

export type AppServerExit = { exitCode: number | null; signal: string | null };

export type AppServerHandlers = {
  notification: (method: string, params: unknown) => void;
  request: (id: CodexRequestId, method: string, params: unknown) => void;
  /** The peer wrote something that is not a protocol message. */
  violation: (message: string) => void;
  exit: (exit: AppServerExit) => void;
};

export type AppServerLaunch = {
  executable: string;
  args: readonly string[];
};

/** Fire-and-forget work whose rejection goes to the caller's error sink. */
export type Detached = (
  operation: unknown,
  context: `${string}.${string}`,
) => void;

type AppServerDeadlines = {
  /** How long a request waits for its answer before the process is ended. */
  requestMs: number;
  /** How long the process gets to exit on SIGTERM before SIGKILL. */
  terminateMs: number;
};

type StartAppServerOptions = {
  launch: AppServerLaunch;
  detached: Detached;
  deadlines: AppServerDeadlines;
  cwd: string;
  env: Readonly<Record<string, string>>;
  handlers: AppServerHandlers;
};

export type AppServerClient = {
  request: (
    method: string,
    params: unknown,
  ) => Promise<Result<unknown, AppServerRequestError>>;
  notify: (method: string, params?: unknown) => void;
  respond: (id: CodexRequestId, result: unknown) => void;
  respondError: (id: CodexRequestId, code: number, message: string) => void;
  /** The server process's id. */
  pid: number;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<AppServerExit>;
  /** Ends stdin, which asks the server to flush its state and exit. */
  closeInput: () => void;
  /** SIGTERM, then SIGKILL once the termination deadline passes. */
  kill: () => Promise<AppServerExit>;
};

type Pending = (result: Result<unknown, AppServerRequestError>) => void;

export const startAppServer = ({
  launch,
  detached,
  deadlines,
  cwd,
  env,
  handlers,
}: StartAppServerOptions): AppServerClient => {
  const child = Bun.spawn([launch.executable, ...launch.args], {
    cwd,
    env: { ...env },
    stdin: "pipe",
    stdout: "pipe",
    // Drained, never surfaced: harness logs may carry account details.
    stderr: "ignore",
  });
  const pending = new Map<CodexRequestId, Pending>();
  const state = { nextId: 1, closed: false, terminating: false };

  /**
   * The one way the process is ended: SIGTERM, then SIGKILL if it has not
   * exited by the deadline, so no wait on its exit is unbounded.
   */
  const terminate = () => {
    if (state.closed || state.terminating) {
      return;
    }
    state.terminating = true;
    child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      child.kill("SIGKILL");
    }, deadlines.terminateMs);
    detached(
      (async () => {
        await child.exited;
        clearTimeout(escalation);
      })(),
      "codex-app-server.terminate",
    );
  };

  /**
   * Stdin is the only way to reach the server. Once an operation on it throws,
   * nothing more can be sent, so the process is ended and its exit settles
   * every pending request; a throw racing an exit already under way changes
   * nothing, because that exit is reported through `handlers.exit` anyway.
   */
  const onInput = (operation: () => void) => {
    const done = Result.try(operation);
    if (Result.isError(done)) {
      terminate();
    }
  };

  const write = (message: object) => {
    if (state.closed) {
      return;
    }
    onInput(() => {
      detached(
        child.stdin.write(`${JSON.stringify(message)}\n`),
        "codex-app-server.write",
      );
      detached(child.stdin.flush(), "codex-app-server.flush");
    });
  };

  const dispatch = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    const json = Result.try((): unknown => JSON.parse(line));
    if (Result.isError(json)) {
      handlers.violation("The harness wrote a line that is not JSON.");
      return;
    }
    const parsed = v.safeParse(JsonRpcMessageSchema, json.value);
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
    const settle = pending.get(message.id);
    if (settle === undefined) {
      handlers.violation("The harness answered a request that was not sent.");
      return;
    }
    pending.delete(message.id);
    settle(
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
  };

  const readStdout = async () => {
    const lines = createLineReader({
      maxLineBytes: MAX_LINE_BYTES,
      line: dispatch,
      oversized: () => {
        handlers.violation("The harness wrote an oversized message.");
        terminate();
      },
    });
    for await (const bytes of child.stdout) {
      lines.push(bytes);
    }
    lines.end();
  };

  const exited = (async (): Promise<AppServerExit> => {
    await Promise.allSettled([readStdout(), child.exited]);
    state.closed = true;
    for (const settle of pending.values()) {
      settle(
        Result.err(
          new AppServerRequestError({
            reason: "closed",
            code: null,
            message: "The harness exited before it answered.",
          }),
        ),
      );
    }
    pending.clear();
    const exit = {
      exitCode: child.exitCode,
      signal: child.signalCode === null ? null : String(child.signalCode),
    };
    handlers.exit(exit);
    return exit;
  })();

  return {
    pid: child.pid,
    request: async (method, params) => {
      if (state.closed) {
        return Result.err(
          new AppServerRequestError({
            reason: "closed",
            code: null,
            message: "The harness is not running.",
          }),
        );
      }
      const id = state.nextId;
      state.nextId += 1;
      const { promise, resolve } =
        Promise.withResolvers<Result<unknown, AppServerRequestError>>();
      pending.set(id, resolve);
      const deadline = setTimeout(() => {
        if (!pending.delete(id)) {
          return;
        }
        resolve(
          Result.err(
            new AppServerRequestError({
              reason: "timed_out",
              code: null,
              message: `The harness did not answer ${method} in time.`,
            }),
          ),
        );
        // A server that stops answering cannot be trusted with the session.
        terminate();
      }, deadlines.requestMs);
      write({ id, method, params });
      const result = await promise;
      clearTimeout(deadline);
      return result;
    },
    notify: (method, params) => {
      write(params === undefined ? { method } : { method, params });
    },
    respond: (id, result) => {
      write({ id, result });
    },
    respondError: (id, code, message) => {
      write({ id, error: { code, message } });
    },
    exited,
    closeInput: () => {
      if (!state.closed) {
        onInput(() => {
          detached(child.stdin.end(), "codex-app-server.close");
        });
      }
    },
    kill: async () => {
      terminate();
      return exited;
    },
  };
};
