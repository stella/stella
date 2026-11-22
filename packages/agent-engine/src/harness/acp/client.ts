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
  type AcpClientNotificationMethod,
  type AcpClientRequestMethod,
  AcpJsonRpcMessageSchema,
  type AcpRequestId,
} from "./protocol";

/**
 * JSON-RPC 2.0 over the stdio of one ACP agent process. The shared harness
 * process owns the process and bounds every wait on it; this client
 * correlates ids. A prompt is answered only when its turn ends, which may be
 * hours later, so it waits without a deadline: the process's exit or the
 * turn's stop settles it instead.
 */

export class AcpRequestError extends TaggedError("AcpRequestError")<{
  reason: "rejected" | "closed" | "timed_out";
  code: number | null;
  message: string;
}> {}

export type AcpAnswer = Result<unknown, AcpRequestError>;

export type AcpHandlers = {
  notification: (method: string, params: unknown) => void;
  request: (id: AcpRequestId, method: string, params: unknown) => void;
  /** The agent wrote something that is not a protocol message. */
  violation: (message: string) => void;
  exit: (exit: HarnessExit) => void;
};

export type AcpLaunch = {
  executable: string;
  args: readonly string[];
};

/**
 * How long a request may wait: the request deadline, the startup deadline
 * (the first launch of an agent that unpacks itself, connecting stella's
 * MCP server), or none (a prompt).
 */
type AcpWait = "request" | "startup" | "unbounded";

const STARTUP_REQUESTS: ReadonlySet<AcpClientRequestMethod> = new Set([
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/resume",
]);

const UNBOUNDED_REQUESTS: ReadonlySet<AcpClientRequestMethod> = new Set([
  "session/prompt",
]);

const waitOf = (method: AcpClientRequestMethod): AcpWait => {
  if (UNBOUNDED_REQUESTS.has(method)) {
    return "unbounded";
  }
  return STARTUP_REQUESTS.has(method) ? "startup" : "request";
};

export type AcpClient = {
  /** Sends a request and settles with its answer. */
  request: (
    method: AcpClientRequestMethod,
    params: unknown,
  ) => Promise<AcpAnswer>;
  notify: (method: AcpClientNotificationMethod, params: unknown) => void;
  respond: (id: AcpRequestId, result: unknown) => void;
  respondError: (id: AcpRequestId, code: number, message: string) => void;
  /** The agent process's id. */
  pid: number;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<HarnessExit>;
  /** Bounded tail of stderr captured in memory for error classification. */
  stderr: () => string;
  /** Ends stdin, which asks the agent to exit. */
  closeInput: () => void;
  /** SIGTERM, then SIGKILL once the termination deadline passes. */
  kill: () => Promise<HarnessExit>;
};

type StartAcpAgentOptions = {
  launch: AcpLaunch;
  protocolLog: ProtocolLog;
  detached: Detached;
  deadlines: HarnessProcessDeadlines;
  cwd: string;
  env: Readonly<Record<string, string>>;
  captureStderr?: boolean | undefined;
  handlers: AcpHandlers;
};

const rejected = (code: number | null, message: string) =>
  Result.err(new AcpRequestError({ reason: "rejected", code, message }));

export const startAcpAgent = ({
  launch,
  protocolLog,
  detached,
  deadlines,
  cwd,
  env,
  captureStderr = false,
  handlers,
}: StartAcpAgentOptions): Result<AcpClient, HarnessSpawnError> => {
  const state = { nextId: 1, exited: false };
  /** Prompts in flight: answered by the agent or by its exit. */
  const unbounded = new Map<AcpRequestId, (answer: AcpAnswer) => void>();

  const dispatch = (value: unknown) => {
    const parsed = v.safeParse(AcpJsonRpcMessageSchema, value);
    if (!parsed.success) {
      handlers.violation("The agent wrote a message that is not JSON-RPC.");
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
    if (message.id === null) {
      // An error about a message the agent could not read. A request with a
      // deadline times out on its own; a prompt has none, so one waiting
      // may be the message it could not read, and the turn cannot go on.
      if (unbounded.size > 0) {
        handlers.violation("The agent could not read a message stella sent.");
      }
      return;
    }
    const answer: AcpAnswer =
      "error" in message
        ? rejected(message.error.code, message.error.message)
        : Result.ok(message.result ?? null);
    const waiting = unbounded.get(message.id);
    if (waiting !== undefined) {
      unbounded.delete(message.id);
      waiting(answer);
      return;
    }
    if (!agent.settle(message.id, answer)) {
      handlers.violation("The agent answered a request that was not sent.");
    }
  };

  const started = startHarnessProcess<AcpRequestId, AcpRequestError>({
    command: [launch.executable, ...launch.args],
    cwd,
    env,
    detached,
    deadlines,
    name: "acp-agent",
    captureStderr,
    protocol: { channel: "acp", log: protocolLog },
    unanswered: (reason, message) =>
      new AcpRequestError({ reason, code: null, message }),
    message: dispatch,
    violation: handlers.violation,
    exit: (exit) => {
      state.exited = true;
      for (const settle of unbounded.values()) {
        settle(
          Result.err(
            new AcpRequestError({
              reason: "closed",
              code: null,
              message: "The agent exited before it answered.",
            }),
          ),
        );
      }
      unbounded.clear();
      handlers.exit(exit);
    },
  });
  if (Result.isError(started)) {
    return started;
  }
  const agent = started.value;

  return Result.ok({
    pid: agent.pid,
    request: async (method, params) => {
      const id = state.nextId;
      state.nextId += 1;
      const message = { jsonrpc: "2.0", id, method, params };
      const wait = waitOf(method);
      if (wait !== "unbounded") {
        return agent.request(
          id,
          method,
          message,
          wait === "startup" ? deadlines.startupRequestMs : undefined,
        );
      }
      if (state.exited) {
        return Result.err(
          new AcpRequestError({
            reason: "closed",
            code: null,
            message: "The agent is not running.",
          }),
        );
      }
      const { promise, resolve } = Promise.withResolvers<AcpAnswer>();
      unbounded.set(id, resolve);
      agent.write(message);
      return promise;
    },
    notify: (method, params) => {
      agent.write({ jsonrpc: "2.0", method, params });
    },
    respond: (id, result) => {
      agent.write({ jsonrpc: "2.0", id, result });
    },
    respondError: (id, code, message) => {
      agent.write({ jsonrpc: "2.0", id, error: { code, message } });
    },
    exited: agent.exited,
    stderr: agent.stderr,
    closeInput: agent.closeInput,
    kill: agent.kill,
  });
};
