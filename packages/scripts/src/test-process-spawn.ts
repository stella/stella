import { panic, Result, TaggedError } from "better-result";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createWindowsProcessOwnership,
  readWindowsProcessIdentity,
} from "./windows-process-ownership";

class TestProcessSpawnError extends TaggedError("TestProcessSpawnError")<{
  message: string;
  cause: unknown;
}> {}

type SpawnTestProcessOptions<
  In extends Bun.Spawn.Writable,
  Out extends Bun.Spawn.Readable,
  Err extends Bun.Spawn.Readable,
> = {
  command: string[];
  options: Bun.Spawn.SpawnOptions<In, Out, Err>;
  onWarning: (message: string) => void;
};

/** Register a Bun leader before its entry point can spawn any descendants. */
export const spawnGatedTestProcess = <
  const In extends Bun.Spawn.Writable,
  const Out extends Bun.Spawn.Readable,
  const Err extends Bun.Spawn.Readable,
>(
  { command, options, onWarning }: SpawnTestProcessOptions<In, Out, Err>,
  readIdentity = readWindowsProcessIdentity,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-test-startup-"));
  const gate = path.join(directory, "pending");
  writeFileSync(gate, "", { mode: 0o600 });
  let child: Bun.Subprocess<In, Out, Err> | undefined;
  const spawned = Result.try({
    try: () => {
      if (command.length === 0) {
        panic("Missing test executable");
      }
      // Bun dispatches a subcommand before parsing its runtime flags. Inserting
      // a preload before `test` would select a package script instead.
      const testIndex = command.indexOf("test");
      const insertion = testIndex === -1 ? 1 : testIndex + 1;
      child = Bun.spawn(
        [
          ...command.slice(0, insertion),
          "--preload",
          `${import.meta.dir}/test-process-startup-gate.ts`,
          ...command.slice(insertion),
        ],
        {
          ...options,
          env: {
            ...(options.env ?? process.env),
            STELLA_TEST_PROCESS_STARTUP_GATE: gate,
          },
        },
      );
      const identity = readIdentity(child.pid);
      if (identity.isErr()) {
        return Result.err(
          new TestProcessSpawnError({
            message: `Cannot register test leader: ${identity.error.message}`,
            cause: identity.error,
          }),
        );
      }
      if (identity.value === undefined) {
        return Result.err(
          new TestProcessSpawnError({
            message: "Test leader exited before ownership registration",
            cause: child.pid,
          }),
        );
      }
      const windowsProcesses = createWindowsProcessOwnership({
        rootPid: child.pid,
        rootIdentity: identity.value,
        onWarning,
      });
      rmSync(directory, { recursive: true });
      return Result.ok({ child, windowsProcesses });
    },
    catch: (cause) =>
      new TestProcessSpawnError({ message: String(cause), cause }),
  }).andThen((result) => result);
  if (spawned.isErr()) {
    // A failed registration must never release unowned test code.
    // If termination itself fails, leave the gate closed until its timeout.
    child?.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
  return spawned.unwrap();
};

export const spawnTestProcess = <
  const In extends Bun.Spawn.Writable,
  const Out extends Bun.Spawn.Readable,
  const Err extends Bun.Spawn.Readable,
>(
  args: SpawnTestProcessOptions<In, Out, Err>,
) => {
  const executable = args.command.at(0) ?? panic("Missing test executable");
  if (
    process.platform === "win32" &&
    /^(?:bun|bun\.exe)$/iu.test(path.basename(executable))
  ) {
    return spawnGatedTestProcess(args);
  }
  // Native leaf utilities (the API snapshot archive check uses tar) have no
  // Bun entry point to preload. Retain their normal process ownership.
  const child = Bun.spawn(args.command, args.options);
  const windowsProcesses =
    process.platform === "win32"
      ? createWindowsProcessOwnership({
          rootPid: child.pid,
          onWarning: args.onWarning,
        })
      : undefined;
  return { child, windowsProcesses };
};
