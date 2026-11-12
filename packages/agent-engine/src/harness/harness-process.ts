import { Result } from "better-result";

import {
  type ProtocolChannel,
  type ProtocolLog,
  protocolTap,
} from "../protocol-log";
import { createLineReader } from "./json-lines";
import {
  type HarnessSpawnError,
  spawnHarnessProcessTree,
} from "./process-tree";
import type { Detached, HarnessExit } from "./turn-lifecycle";

/**
 * One harness process spoken to as newline-delimited JSON over stdio, the
 * transport every harness client shares. It owns the process and bounds every
 * wait on it: a request the harness does not answer in time ends the process,
 * a process that outlives its termination signal is killed outright, and when
 * it exits every pending request settles as unanswered. Ending it ends every
 * process it started too (`process-tree.ts`), and so does its own exit.
 */

/** A line longer than this is refused rather than buffered without bound. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export type HarnessProcessDeadlines = {
  /** How long a request waits for its answer before the process is ended. */
  requestMs: number;
  /**
   * How long a startup request waits instead (the first launch, connecting
   * stella's MCP server): a slow computer is not a hung harness. `requestMs`
   * when unset.
   */
  startupRequestMs?: number | undefined;
  /**
   * How long the process, and every process it started, gets to exit on
   * SIGTERM before SIGKILL.
   */
  terminateMs: number;
};

type StartHarnessProcessOptions<TError> = {
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  detached: Detached;
  deadlines: HarnessProcessDeadlines;
  /** Names the process in detached failures, e.g. `claude-cli`. */
  name: string;
  /** Which protocol the process speaks, and where its lines are logged. */
  protocol: { channel: ProtocolChannel; log: ProtocolLog };
  /** The failure of a request the harness can no longer answer. */
  unanswered: (reason: "closed" | "timed_out", message: string) => TError;
  /** One JSON value the harness wrote. */
  message: (value: unknown) => void;
  /** The harness wrote something that is not a protocol message. */
  violation: (message: string) => void;
  exit: (exit: HarnessExit) => void;
};

type HarnessProcess<TId, TError> = {
  /** The harness process's id, for the desktop to track it. */
  pid: number;
  /** Writes one message; dropped once the process has exited. */
  write: (message: object) => void;
  /**
   * Writes `message` as the request `id` and waits for `settle` with that id,
   * the deadline, or the process's exit, whichever comes first.
   */
  /** `timeoutMs` overrides the process's request deadline for this one. */
  request: (
    id: TId,
    label: string,
    message: object,
    timeoutMs?: number,
  ) => Promise<Result<unknown, TError>>;
  /** Answers the pending request `id`; false when none is pending. */
  settle: (id: TId, result: Result<unknown, TError>) => boolean;
  /** Settles when the process has exited, however that happened. */
  exited: Promise<HarnessExit>;
  /** Ends stdin, which asks the harness to finish and exit. */
  closeInput: () => void;
  /**
   * SIGTERM to the process and every process it started, then SIGKILL once
   * the termination deadline passes.
   */
  kill: () => Promise<HarnessExit>;
};

/** Start the harness; refused when its executable is missing or cannot run. */
export const startHarnessProcess = <TId, TError>({
  command,
  cwd,
  env,
  detached,
  deadlines,
  name,
  protocol,
  unanswered,
  message,
  violation,
  exit,
}: StartHarnessProcessOptions<TError>): Result<
  HarnessProcess<TId, TError>,
  HarnessSpawnError
> => {
  const spawned = spawnHarnessProcessTree({
    command,
    cwd,
    env,
    terminateMs: deadlines.terminateMs,
  });
  if (Result.isError(spawned)) {
    return spawned;
  }
  const tree = spawned.value;
  const { child } = tree;
  const tap = protocolTap(protocol.log, {
    channel: protocol.channel,
    source: `pid=${String(child.pid)}`,
  });
  const pending = new Map<TId, (result: Result<unknown, TError>) => void>();
  const state = { closed: false, terminating: false };

  /**
   * The one way the process is ended: SIGTERM to it and everything it
   * started, then SIGKILL to what is left by the deadline, so no wait on its
   * exit is unbounded.
   */
  const terminate = () => {
    if (state.closed || state.terminating) {
      return;
    }
    state.terminating = true;
    detached(tree.end(), `${name}.terminate`);
  };

  /**
   * Stdin is the only way to reach the harness. Once an operation on it
   * throws, nothing more can be sent, so the process is ended and its exit
   * settles every pending request; a throw racing an exit already under way
   * changes nothing, because that exit is reported through `exit` anyway.
   */
  const onInput = (operation: () => void) => {
    const done = Result.try(operation);
    if (Result.isError(done)) {
      terminate();
    }
  };

  const write = (outgoing: object) => {
    if (state.closed) {
      return;
    }
    onInput(() => {
      const line = JSON.stringify(outgoing);
      tap("out", line);
      detached(child.stdin.write(`${line}\n`), `${name}.write`);
      detached(child.stdin.flush(), `${name}.flush`);
    });
  };

  const dispatch = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    tap("in", line);
    const json = Result.try((): unknown => JSON.parse(line));
    if (Result.isError(json)) {
      violation("The harness wrote a line that is not JSON.");
      return;
    }
    message(json.value);
  };

  const readStdout = async () => {
    const lines = createLineReader({
      maxLineBytes: MAX_LINE_BYTES,
      line: dispatch,
      oversized: () => {
        violation("The harness wrote an oversized message.");
        terminate();
      },
    });
    for await (const bytes of child.stdout) {
      lines.push(bytes);
    }
    lines.end();
  };

  const reading = Promise.allSettled([readStdout()]);
  const exited = (async (): Promise<HarnessExit> => {
    await child.exited;
    // What it started goes with it, however it exited: a turn's end, a stop
    // or a crash leaves nothing running in the chat's folder. They may hold
    // its stdout, which ends only once they are gone.
    await tree.end();
    await reading;
    state.closed = true;
    for (const settle of pending.values()) {
      settle(
        Result.err(
          unanswered("closed", "The harness exited before it answered."),
        ),
      );
    }
    pending.clear();
    const ended = {
      exitCode: child.exitCode,
      signal: child.signalCode === null ? null : String(child.signalCode),
    };
    exit(ended);
    return ended;
  })();

  return Result.ok({
    pid: child.pid,
    write,
    request: async (id, label, outgoing, timeoutMs) => {
      if (state.closed) {
        return Result.err(unanswered("closed", "The harness is not running."));
      }
      const { promise, resolve } =
        Promise.withResolvers<Result<unknown, TError>>();
      pending.set(id, resolve);
      const deadline = setTimeout(() => {
        if (!pending.delete(id)) {
          return;
        }
        resolve(
          Result.err(
            unanswered(
              "timed_out",
              `The harness did not answer ${label} in time.`,
            ),
          ),
        );
        // A harness that stops answering cannot be trusted with the session.
        terminate();
      }, timeoutMs ?? deadlines.requestMs);
      write(outgoing);
      const result = await promise;
      clearTimeout(deadline);
      return result;
    },
    settle: (id, result) => {
      const settle = pending.get(id);
      if (settle === undefined) {
        return false;
      }
      pending.delete(id);
      settle(result);
      return true;
    },
    exited,
    closeInput: () => {
      if (!state.closed) {
        onInput(() => {
          detached(child.stdin.end(), `${name}.close`);
        });
      }
    },
    kill: async () => {
      terminate();
      return exited;
    },
  });
};
