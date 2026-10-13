import { panic, Result, TaggedError } from "better-result";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createWindowsProcessOwnership,
  type WindowsProcessOwnership,
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
  limitBytes: number;
  options: Bun.Spawn.SpawnOptions<In, Out, Err>;
  onWarning: (message: string) => void;
};

/** Register a Bun leader before its entry point can spawn any descendants. */
export const spawnGatedTestProcess = <
  const In extends Bun.Spawn.Writable,
  const Out extends Bun.Spawn.Readable,
  const Err extends Bun.Spawn.Readable,
>(
  {
    command,
    options,
    onWarning,
    limitBytes,
  }: SpawnTestProcessOptions<In, Out, Err>,
  registerJob: (
    args: Parameters<typeof createWindowsProcessOwnership>[0],
  ) => Result<WindowsProcessOwnership, Error> = createWindowsProcessOwnership,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-test-startup-"));
  const gate = path.join(directory, "pending");
  writeFileSync(gate, "", { mode: 0o600 });
  let child: Bun.Subprocess<In, Out, Err> | undefined;
  let windowsProcesses: WindowsProcessOwnership | undefined;
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
      const registered = registerJob({ rootPid: child.pid, limitBytes });
      if (registered.isErr()) {
        onWarning(registered.error.message);
        return Result.err(
          new TestProcessSpawnError({
            message: `Cannot register test leader: ${registered.error.message}`,
            cause: registered.error,
          }),
        );
      }
      windowsProcesses = registered.value;
      rmSync(directory, { recursive: true });
      return Result.ok({ child, windowsProcesses });
    },
    catch: (cause) =>
      new TestProcessSpawnError({ message: String(cause), cause }),
  }).andThen((result) => result);
  if (spawned.isErr()) {
    // A failed registration must never release unowned test code.
    // If termination itself fails, leave the gate closed until its timeout.
    if (windowsProcesses === undefined) {
      child?.kill("SIGKILL");
    } else {
      windowsProcesses.signal("SIGKILL").unwrap();
    }
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
  // A gated Bun launcher puts native commands in the same inherited job too.
  if (process.platform === "win32") {
    return spawnGatedTestProcess({
      ...args,
      command: [
        process.execPath,
        "-e",
        `const cmd=JSON.parse(process.env.STELLA_TEST_NATIVE_COMMAND); delete process.env.STELLA_TEST_NATIVE_COMMAND; const child=Bun.spawn(cmd,{stdin:'inherit',stdout:'inherit',stderr:'inherit'}); process.exit(await child.exited);`,
      ],
      options: {
        ...args.options,
        env: {
          ...(args.options.env ?? process.env),
          STELLA_TEST_NATIVE_COMMAND: JSON.stringify(args.command),
        },
      },
    });
  }
  const child = Bun.spawn(args.command, args.options);
  return { child, windowsProcesses: undefined };
};
