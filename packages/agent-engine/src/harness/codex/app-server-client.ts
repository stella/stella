import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { type CodexRequestId, JsonRpcMessageSchema } from "./protocol";

/**
 * JSON-RPC over the stdio of one `codex app-server` process: one JSON object
 * per line in each direction. The client owns the process; when it exits,
 * every pending request settles with `closed`.
 */

/** A line longer than this is refused rather than buffered without bound. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class AppServerRequestError extends TaggedError(
  "AppServerRequestError",
)<{
  reason: "rejected" | "closed";
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

type StartAppServerOptions = {
  launch: AppServerLaunch;
  detached: Detached;
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
  /** Settles when the process has exited, however that happened. */
  exited: Promise<AppServerExit>;
  /** Ends stdin, which asks the server to flush its state and exit. */
  closeInput: () => void;
  kill: () => Promise<AppServerExit>;
};

type Pending = (result: Result<unknown, AppServerRequestError>) => void;

export const startAppServer = ({
  launch,
  detached,
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
  const state = { nextId: 1, closed: false };

  const write = (message: object) => {
    if (state.closed) {
      return;
    }
    // A write racing the process's exit fails; the exit itself is reported
    // through `handlers.exit`, so the failed write carries no extra news.
    Result.try(() => {
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
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        dispatch(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_BYTES) {
        handlers.violation("The harness wrote an oversized message.");
        buffer = "";
        child.kill();
      }
    }
    dispatch(buffer + decoder.decode());
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
    request: (method, params) => {
      if (state.closed) {
        return Promise.resolve(
          Result.err(
            new AppServerRequestError({
              reason: "closed",
              code: null,
              message: "The harness is not running.",
            }),
          ),
        );
      }
      const id = state.nextId;
      state.nextId += 1;
      const { promise, resolve } =
        Promise.withResolvers<Result<unknown, AppServerRequestError>>();
      pending.set(id, resolve);
      write({ id, method, params });
      return promise;
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
        Result.try(() => {
          detached(child.stdin.end(), "codex-app-server.close");
        });
      }
    },
    kill: async () => {
      if (!state.closed) {
        child.kill();
      }
      return exited;
    },
  };
};
