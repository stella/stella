import { Result } from "better-result";
import { spawn } from "node:child_process";

import {
  SKILL_RUNNER_LIMITS,
  SKILL_RUNNER_OUTCOME,
} from "@stll/api-contract/skill-runner";

export type CapturedStream = { text: string; droppedBytes: number };

export type CommandOutcome = {
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

/**
 * Run one command in its own process group, so a timeout ends everything it
 * started. Never through a shell: `argv[0]` is the program.
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
    const finish = (
      outcome: Omit<CommandOutcome, "stdout" | "stderr" | "durationMs">,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
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
      if (
        group === undefined ||
        Result.try(() => process.kill(-group, "SIGKILL")).isErr()
      ) {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(String(error.message)));
      finish({
        outcome: SKILL_RUNNER_OUTCOME.notStarted,
        exitCode: null,
        signal: null,
      });
    });
    child.on("close", (code, signal) => {
      finish({
        outcome: timedOut
          ? SKILL_RUNNER_OUTCOME.timedOut
          : SKILL_RUNNER_OUTCOME.exited,
        exitCode: code,
        signal,
      });
    });
  });
};
