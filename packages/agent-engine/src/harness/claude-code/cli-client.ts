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
  type ClaudeHostControlRequest,
  ClaudeOutputEnvelopeSchema,
  ControlCancelRequestSchema,
  ControlRequestSchema,
  ControlResponseSchema,
} from "./protocol";

/**
 * The stream-json stdio of one Claude Code CLI process: one JSON object per
 * line in each direction. Control requests are correlated by `request_id`;
 * every other line is handed on by its `type`. The shared harness process
 * owns the process and bounds every wait on it.
 */

class ClaudeCliRequestError extends TaggedError("ClaudeCliRequestError")<{
  reason: "rejected" | "closed" | "timed_out";
  message: string;
}> {}

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
  exit: (exit: HarnessExit) => void;
};

export type ClaudeCliLaunch = {
  executable: string;
  /** Arguments placed before the adapter's own, such as a script path. */
  args: readonly string[];
};

type StartClaudeCliOptions = {
  launch: ClaudeCliLaunch;
  protocolLog: ProtocolLog;
  args: readonly string[];
  detached: Detached;
  deadlines: HarnessProcessDeadlines;
  cwd: string;
  env: Readonly<Record<string, string>>;
  handlers: ClaudeCliHandlers;
};

/**
 * Startup requests, which wait on the startup deadline: initialize covers
 * the CLI's first launch (an antivirus scan, a busy computer); registering
 * stella's MCP server waits on the CLI's own connect, itself up to 30
 * seconds a server.
 */
const STARTUP_REQUESTS: ReadonlySet<ClaudeHostControlRequest> = new Set([
  "initialize",
  "mcp_set_servers",
]);

export type ClaudeCliClient = {
  /** Sends a control request and settles with its response payload. */
  request: (
    subtype: ClaudeHostControlRequest,
    fields?: Record<string, unknown>,
  ) => Promise<Result<unknown, ClaudeCliRequestError>>;
  /** Writes a conversation message, such as the turn's user message. */
  send: (message: object) => void;
  respond: (requestId: string, response: object) => void;
  respondError: (requestId: string, message: string) => void;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<HarnessExit>;
  /** Ends stdin, which asks the CLI to finish and exit. */
  closeInput: () => void;
  /** SIGTERM, then SIGKILL once the termination deadline passes. */
  kill: () => Promise<HarnessExit>;
};

export const startClaudeCli = ({
  launch,
  protocolLog,
  args,
  detached,
  deadlines,
  cwd,
  env,
  handlers,
}: StartClaudeCliOptions): Result<ClaudeCliClient, HarnessSpawnError> => {
  const state = { nextId: 1 };

  const settleResponse = (raw: unknown) => {
    const parsed = v.safeParse(ControlResponseSchema, raw);
    if (!parsed.success) {
      handlers.violation("The harness wrote a malformed control response.");
      return;
    }
    const { response } = parsed.output;
    const answered = cli.settle(
      response.request_id,
      response.subtype === "error"
        ? Result.err(
            new ClaudeCliRequestError({
              reason: "rejected",
              message: response.error,
            }),
          )
        : Result.ok(response.response ?? {}),
    );
    if (!answered) {
      handlers.violation("The harness answered a request that was not sent.");
    }
  };

  const dispatch = (value: unknown) => {
    const envelope = v.safeParse(ClaudeOutputEnvelopeSchema, value);
    if (!envelope.success) {
      handlers.violation("The harness wrote a message without a type.");
      return;
    }
    switch (envelope.output.type) {
      case "control_response":
        settleResponse(value);
        return;
      case "control_request": {
        const parsed = v.safeParse(ControlRequestSchema, value);
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
        const parsed = v.safeParse(ControlCancelRequestSchema, value);
        if (!parsed.success) {
          handlers.violation("The harness wrote a malformed cancel request.");
          return;
        }
        handlers.controlCancel(parsed.output.request_id);
        return;
      }
      default:
        handlers.message(envelope.output.type, value);
    }
  };

  const started = startHarnessProcess<string, ClaudeCliRequestError>({
    command: [launch.executable, ...launch.args, ...args],
    cwd,
    env,
    detached,
    deadlines,
    name: "claude-cli",
    protocol: { channel: "claude-code", log: protocolLog },
    unanswered: (reason, message) =>
      new ClaudeCliRequestError({ reason, message }),
    message: dispatch,
    violation: handlers.violation,
    exit: handlers.exit,
  });
  if (Result.isError(started)) {
    return started;
  }
  const cli = started.value;

  return Result.ok({
    request: async (subtype, fields = {}) => {
      const requestId = `stella-${String(state.nextId)}`;
      state.nextId += 1;
      return await cli.request(
        requestId,
        subtype,
        {
          type: "control_request",
          request_id: requestId,
          request: { ...fields, subtype },
        },
        STARTUP_REQUESTS.has(subtype) ? deadlines.startupRequestMs : undefined,
      );
    },
    send: cli.write,
    respond: (requestId, response) => {
      cli.write({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
    },
    respondError: (requestId, message) => {
      cli.write({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: message },
      });
    },
    exited: cli.exited,
    closeInput: cli.closeInput,
    kill: cli.kill,
  });
};
