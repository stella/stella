import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  ClaudeOutputEnvelopeSchema,
  ControlCancelRequestSchema,
  ControlRequestSchema,
  ControlResponseSchema,
} from "./protocol";

/**
 * The stream-json stdio of one Claude Code CLI process: one JSON object per
 * line in each direction. Control requests are correlated by `request_id`;
 * every other line is handed on by its `type`. The client owns the process;
 * when it exits, every pending control request settles with `closed`.
 */

/** A line longer than this is refused rather than buffered without bound. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

class ClaudeCliRequestError extends TaggedError("ClaudeCliRequestError")<{
  reason: "rejected" | "closed";
  message: string;
}> {}

export type ClaudeCliExit = { exitCode: number | null; signal: string | null };

export type ClaudeCliHandlers = {
  /** A conversation message; `raw` is the whole line, parsed. */
  message: (type: string, raw: unknown) => void;
  controlRequest: (
    requestId: string,
    subtype: string,
    request: unknown,
  ) => void;
  /** The CLI withdrew a control request it sent. */
  controlCancel: (requestId: string) => void;
  /** The peer wrote something that is not a protocol message. */
  violation: (message: string) => void;
  exit: (exit: ClaudeCliExit) => void;
};

export type ClaudeCliLaunch = {
  executable: string;
  /** Arguments placed before the adapter's own, such as a script path. */
  args: readonly string[];
};

/** Fire-and-forget work whose rejection goes to the caller's error sink. */
export type Detached = (
  operation: unknown,
  context: `${string}.${string}`,
) => void;

type StartClaudeCliOptions = {
  launch: ClaudeCliLaunch;
  args: readonly string[];
  detached: Detached;
  cwd: string;
  env: Readonly<Record<string, string>>;
  handlers: ClaudeCliHandlers;
};

export type ClaudeCliClient = {
  /** Sends a control request and settles with its response payload. */
  request: (
    subtype: string,
    fields?: Record<string, unknown>,
  ) => Promise<Result<unknown, ClaudeCliRequestError>>;
  /** Writes a conversation message, such as the turn's user message. */
  send: (message: object) => void;
  respond: (requestId: string, response: object) => void;
  respondError: (requestId: string, message: string) => void;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<ClaudeCliExit>;
  /** Ends stdin, which asks the CLI to finish and exit. */
  closeInput: () => void;
  kill: () => Promise<ClaudeCliExit>;
};

type Pending = (result: Result<unknown, ClaudeCliRequestError>) => void;

export const startClaudeCli = ({
  launch,
  args,
  detached,
  cwd,
  env,
  handlers,
}: StartClaudeCliOptions): ClaudeCliClient => {
  const child = Bun.spawn([launch.executable, ...launch.args, ...args], {
    cwd,
    env: { ...env },
    stdin: "pipe",
    stdout: "pipe",
    // Drained, never surfaced: harness logs may carry account details.
    stderr: "ignore",
  });
  const pending = new Map<string, Pending>();
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
        "claude-cli.write",
      );
      detached(child.stdin.flush(), "claude-cli.flush");
    });
  };

  const settleResponse = (raw: unknown) => {
    const parsed = v.safeParse(ControlResponseSchema, raw);
    if (!parsed.success) {
      handlers.violation("The harness wrote a malformed control response.");
      return;
    }
    const { response } = parsed.output;
    const settle = pending.get(response.request_id);
    if (settle === undefined) {
      handlers.violation("The harness answered a request that was not sent.");
      return;
    }
    pending.delete(response.request_id);
    settle(
      response.subtype === "error"
        ? Result.err(
            new ClaudeCliRequestError({
              reason: "rejected",
              message: response.error,
            }),
          )
        : Result.ok(response.response ?? {}),
    );
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
    const envelope = v.safeParse(ClaudeOutputEnvelopeSchema, json.value);
    if (!envelope.success) {
      handlers.violation("The harness wrote a message without a type.");
      return;
    }
    switch (envelope.output.type) {
      case "control_response":
        settleResponse(json.value);
        return;
      case "control_request": {
        const parsed = v.safeParse(ControlRequestSchema, json.value);
        if (!parsed.success) {
          handlers.violation("The harness wrote a malformed control request.");
          return;
        }
        handlers.controlRequest(
          parsed.output.request_id,
          parsed.output.request.subtype,
          parsed.output.request,
        );
        return;
      }
      case "control_cancel_request": {
        const parsed = v.safeParse(ControlCancelRequestSchema, json.value);
        if (!parsed.success) {
          handlers.violation("The harness wrote a malformed cancel request.");
          return;
        }
        handlers.controlCancel(parsed.output.request_id);
        return;
      }
      default:
        handlers.message(envelope.output.type, json.value);
    }
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

  const exited = (async (): Promise<ClaudeCliExit> => {
    await Promise.allSettled([readStdout(), child.exited]);
    state.closed = true;
    for (const settle of pending.values()) {
      settle(
        Result.err(
          new ClaudeCliRequestError({
            reason: "closed",
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
    request: async (subtype, fields = {}) => {
      if (state.closed) {
        return Result.err(
          new ClaudeCliRequestError({
            reason: "closed",
            message: "The harness is not running.",
          }),
        );
      }
      const requestId = `stella-${String(state.nextId)}`;
      state.nextId += 1;
      const { promise, resolve } =
        Promise.withResolvers<Result<unknown, ClaudeCliRequestError>>();
      pending.set(requestId, resolve);
      write({
        type: "control_request",
        request_id: requestId,
        request: { ...fields, subtype },
      });
      return await promise;
    },
    send: write,
    respond: (requestId, response) => {
      write({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
    },
    respondError: (requestId, message) => {
      write({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: message },
      });
    },
    exited,
    closeInput: () => {
      if (!state.closed) {
        Result.try(() => {
          detached(child.stdin.end(), "claude-cli.close");
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
