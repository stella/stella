import { Result, TaggedError } from "better-result";

export type WindowsProcessIdentity = {
  pid: number;
  creationTime: bigint;
};

// Stdin avoids the Windows command-line limit for retained identities. Execute
// one block so a later statement cannot hide a cleanup failure.
export const WINDOWS_POWERSHELL_COMMAND = [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "& ([scriptblock]::Create([Console]::In.ReadToEnd()))",
] as const;

class WindowsProcessOwnershipError extends TaggedError(
  "WindowsProcessOwnershipError",
)<{
  message: string;
  cause?: unknown;
}> {}

const runPowerShell = (command: string) =>
  Result.try({
    try: () => {
      const result = Bun.spawnSync([...WINDOWS_POWERSHELL_COMMAND], {
        stdin: new TextEncoder().encode(command),
        timeout: 5000,
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.success
        ? Result.ok(result.stdout.toString().trim())
        : Result.err(
            new WindowsProcessOwnershipError({
              message:
                result.stderr.toString().trim() ||
                "Windows process command failed",
              cause: result.exitCode,
            }),
          );
    },
    catch: (cause) =>
      new WindowsProcessOwnershipError({ message: String(cause), cause }),
  }).andThen((result) => result);

/** FILETIME is wider than JS's safe integer range; never round an identity. */
export const parseWindowsCreationTime = (value: string) =>
  /^[1-9]\d*$/u.test(value)
    ? Result.ok(BigInt(value))
    : Result.err(
        new WindowsProcessOwnershipError({
          message: "Invalid Windows process creation time",
        }),
      );

export const readWindowsProcessIdentity = (pid: number) => {
  const result = runPowerShell(`
$ErrorActionPreference='Stop'
$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if($null -eq $p) { exit 0 }
try {
  [void]$p.Handle
  if(!$p.HasExited) { Write-Output $p.StartTime.ToFileTimeUtc().ToString() }
} catch {
  if(!$p.HasExited) { throw }
} finally { $p.Dispose() }
`);
  return result.andThen((output) => {
    if (output === "") {
      return Result.ok(undefined);
    }
    const creation = parseWindowsCreationTime(output);
    return creation.isErr()
      ? Result.err(creation.error)
      : Result.ok({ pid, creationTime: creation.value });
  });
};

type SignalWindowsProcessesOptions = {
  rootPid: number;
  identities: readonly WindowsProcessIdentity[];
  signal: NodeJS.Signals;
};

export const signalWindowsProcesses = ({
  rootPid,
  identities,
  signal,
}: SignalWindowsProcessesOptions) => {
  if (identities.length === 0) {
    return Result.ok(undefined);
  }
  const entries = identities
    .map(({ pid, creationTime }) => `@{Pid=${pid};Created='${creationTime}'}`)
    .join(",");
  // Access Handle before checking StartTime. Process.Kill reuses that handle;
  // a PID cannot be recycled between identity verification and termination.
  // Hold every verified handle across taskkill too, then reap recorded workers
  // individually even when their original root no longer exists.
  return runPowerShell(`
$ErrorActionPreference='Stop'
$owned=@(${entries})
$opened=@()
try {
  foreach($entry in $owned) {
    $p=Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
    if($null -eq $p) { continue }
    $keep=$false
    try {
      [void]$p.Handle
      if(!$p.HasExited -and $p.StartTime.ToFileTimeUtc().ToString() -eq $entry.Created) {
        $opened+=,$p
        $keep=$true
      }
    } catch {
      if(!$p.HasExited) { throw }
    } finally { if(!$keep) { $p.Dispose() } }
  }
  $root=$opened | Where-Object { $_.Id -eq ${rootPid} } | Select-Object -First 1
  $treeFailed=$false
  if($null -ne $root -and !$root.HasExited) {
    $task=[System.Diagnostics.Process]::new()
    try {
      $task.StartInfo.FileName='taskkill.exe'
      $task.StartInfo.Arguments='/PID ${rootPid} /T ${signal === "SIGKILL" ? "/F" : ""}'
      $task.StartInfo.UseShellExecute=$false
      $task.StartInfo.RedirectStandardOutput=$true
      $task.StartInfo.RedirectStandardError=$true
      [void]$task.Start()
      $stdout=$task.StandardOutput.ReadToEndAsync()
      $stderr=$task.StandardError.ReadToEndAsync()
      $task.WaitForExit()
      [void]$stdout.GetAwaiter().GetResult()
      [void]$stderr.GetAwaiter().GetResult()
      $treeFailed=$task.ExitCode -ne 0 -and !$root.HasExited
    } finally { $task.Dispose() }
  }
  ${signal === "SIGKILL" ? "foreach($p in $opened) { try { if(!$p.HasExited) { $p.Kill(); if(!$p.WaitForExit(1000)) { throw 'Windows test worker did not exit' } } } catch { if(!$p.HasExited) { throw } } }" : ""}
  if($treeFailed -and !$root.HasExited) { throw 'Could not terminate Windows test process tree' }
} finally { foreach($p in $opened) { $p.Dispose() } }
`).map(() => undefined);
};

type CreateWindowsProcessOwnershipOptions = {
  rootPid: number;
  onWarning: (message: string) => void;
  readIdentity?: typeof readWindowsProcessIdentity;
  signalProcesses?: typeof signalWindowsProcesses;
};

export const createWindowsProcessOwnership = ({
  rootPid,
  onWarning,
  readIdentity = readWindowsProcessIdentity,
  signalProcesses = signalWindowsProcesses,
}: CreateWindowsProcessOwnershipOptions) => {
  const identities = new Map<number, WindowsProcessIdentity>();
  const capturePid = (pid: number) => {
    const read = readIdentity(pid);
    if (read.isErr()) {
      onWarning(`Cannot retain test process PID ${pid}: ${read.error.message}`);
      return;
    }
    if (read.value !== undefined) {
      identities.set(pid, read.value);
    }
  };
  capturePid(rootPid);
  return {
    // Only the spawning owner may register a known worker directly.
    capturePid,
    recordTree: (sample: readonly WindowsProcessIdentity[]) => {
      const root = identities.get(rootPid);
      const sampledRoot = sample.find(({ pid }) => pid === rootPid);
      if (
        root === undefined ||
        sampledRoot?.creationTime !== root.creationTime
      ) {
        return;
      }
      for (const identity of sample) {
        identities.set(identity.pid, identity);
      }
    },
    signal: (signal: NodeJS.Signals) =>
      signalProcesses({
        rootPid,
        identities: [...identities.values()],
        signal,
      }),
  };
};
