import { Result } from "better-result";

import { createLineReader } from "./json-lines";
import { spawnHarnessProcessTree } from "./process-tree";
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
  request: (
    id: TId,
    label: string,
    message: object,
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

export const startHarnessProcess = <TId, TError>({
  command,
  cwd,
  env,
  detached,
  deadlines,
  name,
  unanswered,
  message,
  violation,
  exit,
}: StartHarnessProcessOptions<TError>): HarnessProcess<TId, TError> => {
  const tree = spawnHarnessProcessTree({
    command,
    cwd,
    env,
    terminateMs: deadlines.terminateMs,
  });
  const { child } = tree;
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
      detached(
        child.stdin.write(`${JSON.stringify(outgoing)}\n`),
        `${name}.write`,
      );
      detached(child.stdin.flush(), `${name}.flush`);
    });
  };

  const dispatch = (line: string) => {
    if (line.trim() === "") {
      return;
    }
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

  return {
    pid: child.pid,
    write,
    request: async (id, label, outgoing) => {
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
      }, deadlines.requestMs);
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
  };
};
