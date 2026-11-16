import { Result } from "better-result";
import { spawn } from "node:child_process";

import {
  SKILL_RUNNER_LIMITS,
  SKILL_RUNNER_OUTCOME,
} from "@stll/api-contract/skill-runner";

type CapturedStream = { text: string; droppedBytes: number };

type CommandOutcome = {
  outcome: (typeof SKILL_RUNNER_OUTCOME)[keyof typeof SKILL_RUNNER_OUTCOME];
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: CapturedStream;
  stderr: CapturedStream;
};

/** Keeps the first `limit` bytes of a stream and counts the rest. */
const capture = (limit: number) => {
  const chunks: Buffer[] = [];
  let kept = 0;
  let dropped = 0;
  return {
    push(chunk: Buffer) {
      const room = limit - kept;
      if (room > 0) {
        const part = chunk.subarray(0, room);
        chunks.push(part);
        kept += part.byteLength;
      }
      dropped += Math.max(0, chunk.byteLength - Math.max(0, room));
    },
    result(): CapturedStream {
      // A cut may split a UTF-8 sequence; the decoder replaces the tail.
      return {
        text: Buffer.concat(chunks).toString("utf-8"),
        droppedBytes: dropped,
      };
    },
  };
};

/** How long output still in the pipes may take to arrive after an exit. */
const STREAM_DRAIN_MS = 2000;

/** SIGKILL a whole process group; false when it has no members left. */
const killGroup = (group: number): boolean =>
  Result.try(() => process.kill(-group, "SIGKILL")).isOk();

/**
 * Run one command in its own process group. Whether it exits or times out,
 * everything it started in that group is ended before the outcome is
 * reported, so nothing it left behind can change the workspace while it is
 * listed and stored. Never through a shell: `argv[0]` is the program.
 */
export const runCommand = async ({
  argv,
  cwd,
  env,
  timeoutMs,
  streamBytes = SKILL_RUNNER_LIMITS.streamBytes,
}: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  streamBytes?: number;
}): Promise<CommandOutcome> => {
  const started = performance.now();
  const stdout = capture(streamBytes);
  const stderr = capture(streamBytes);
  const [program, ...args] = argv;
  return await new Promise<CommandOutcome>((resolve) => {
    let timedOut = false;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      outcome: Omit<CommandOutcome, "stdout" | "stderr" | "durationMs">,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolve({
        ...outcome,
        durationMs: Math.round(performance.now() - started),
        stdout: stdout.result(),
        stderr: stderr.result(),
      });
    };
    const child = spawn(program ?? "", args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const group = child.pid;
      // The whole process group, so nothing the command started survives;
      // the child alone when the group is already gone.
      if (group === undefined || !killGroup(group)) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
      finish({
        outcome: SKILL_RUNNER_OUTCOME.notStarted,
        exitCode: null,
        signal: null,
      });
    });
    child.on("exit", (code, signal) => {
      // A descendant may still run once the command exits; an empty group is
      // the expected case.
      if (child.pid !== undefined) {
        killGroup(child.pid);
      }
      const exited = {
        outcome: timedOut
          ? SKILL_RUNNER_OUTCOME.timedOut
          : SKILL_RUNNER_OUTCOME.exited,
        exitCode: code,
        signal,
      };
      // Output still in the pipes arrives before `close`. A process that left
      // the group can hold them open for good, so the outcome does not wait
      // on it past a short drain: the caller's sweep ends that process.
      child.once("close", () => finish(exited));
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exited);
      }, STREAM_DRAIN_MS);
    });
  });
};
