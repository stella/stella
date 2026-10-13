import { Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

const WINDOWS_FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const NANOS_PER_FILETIME_TICK = 100n;

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

type WindowsProcessRow = {
  pid: number;
  parent: number;
  bytes: number;
  creationTime: bigint | undefined;
};

/** One wire parser serves both memory samples and terminal ownership censuses. */
export const parseWindowsProcessRows = (output: string) => {
  const rows: WindowsProcessRow[] = [];
  let unavailable: WindowsProcessOwnershipError | undefined;
  for (const line of output.trim().split(/\r?\n/u)) {
    if (line === "unknown") {
      unavailable = new WindowsProcessOwnershipError({
        message: "Process ancestry sample unavailable",
      });
      continue;
    }
    const values = line.trim().split(/\s+/u);
    const pid = Number(values.at(0));
    const parent = Number(values.at(1));
    const bytes = Number(values.at(2));
    const created = values.at(3);
    if (
      values.length !== 4 ||
      created === undefined ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parent) ||
      parent < 0
    ) {
      return Result.err(
        new WindowsProcessOwnershipError({
          message: "Invalid process tree sample",
        }),
      );
    }
    const creation = parseWindowsCreationTime(created);
    if (creation.isErr()) {
      unavailable ??= creation.error;
    }
    rows.push({
      pid,
      parent,
      bytes,
      creationTime: creation.isOk() ? creation.value : undefined,
    });
  }
  return Result.ok({ rows, unavailable });
};

type WindowsProcessTreeCommandOptions = {
  rootPid: number;
  creationTime?: bigint;
  exitedBefore?: bigint;
};

/** An exited root still seeds the parent-PID walk with its retained identity. */
export const windowsProcessTreeCommand = ({
  rootPid,
  creationTime,
  exitedBefore,
}: WindowsProcessTreeCommandOptions) => `
$ErrorActionPreference='Stop'
$root=Get-Process -Id ${rootPid} -ErrorAction SilentlyContinue
$rootCreated='${creationTime ?? "unknown"}'
$heldRoot=$false
try {
  if($null -ne $root) {
    try {
      [void]$root.Handle
      $heldRoot=$true
      $observed=$root.StartTime.ToFileTimeUtc().ToString()
      if($rootCreated -ne 'unknown' -and $observed -ne $rootCreated) { exit 0 }
      $rootCreated=$observed
    } catch { if(!$root.HasExited) { throw } }
  }
  $rows=@()
  try { $rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate) }
  catch { Write-Output 'unknown' }
  $metadata=@{}
  foreach($row in $rows) { $metadata[[int]$row.ProcessId]=$row }
  $owned=[System.Collections.Generic.HashSet[int]]::new()
  $queue=[System.Collections.Generic.Queue[int]]::new()
  [void]$owned.Add(${rootPid})
  $queue.Enqueue(${rootPid})
  while($queue.Count -gt 0) {
    $pidValue=$queue.Dequeue()
    foreach($row in $rows) {
      ${exitedBefore === undefined ? "" : `if(!$heldRoot -and $pidValue -eq ${rootPid} -and $row.CreationDate.ToFileTimeUtc() -gt ${exitedBefore}) { continue }`}
      $parentCreated=$null
      if($pidValue -eq ${rootPid} -and $rootCreated -ne 'unknown') { $parentCreated=[DateTime]::FromFileTimeUtc([long]$rootCreated) }
      elseif($metadata.ContainsKey($pidValue)) { $parentCreated=$metadata[$pidValue].CreationDate.ToUniversalTime() }
      if($row.ParentProcessId -eq $pidValue -and $null -ne $parentCreated -and $row.CreationDate.ToUniversalTime() -ge $parentCreated -and $owned.Add([int]$row.ProcessId)) {
        $queue.Enqueue([int]$row.ProcessId)
      }
    }
  }
  $memory=@{}
  $created=@{}
  Get-Process -Id @($owned) -ErrorAction SilentlyContinue | ForEach-Object {
    $p=$_
    try {
      [void]$p.Handle
      $birth=$p.StartTime.ToFileTimeUtc()
      $row=$metadata[[int]$p.Id]
      if($null -ne $row -and [decimal]::Truncate(([decimal]$birth)/10) -eq [decimal]::Truncate(([decimal]($row.CreationDate.ToFileTimeUtc()))/10)) {
        $memory[[int]$p.Id]=$p.WorkingSet64
        $created[[int]$p.Id]=$birth.ToString()
      }
    } catch { $created[[int]$p.Id]='unknown' }
    finally { $p.Dispose() }
  }
  $created[${rootPid}]=$rootCreated
  foreach($pidValue in $owned) {
    $parent=0
    if($metadata.ContainsKey($pidValue)) { $parent=$metadata[$pidValue].ParentProcessId }
    $bytes=-1
    $creation='unknown'
    if($memory.ContainsKey($pidValue)) { $bytes=$memory[$pidValue] }
    if($created.ContainsKey($pidValue)) { $creation=$created[$pidValue] }
    Write-Output "$pidValue $parent $bytes $creation"
  }
} finally { if($null -ne $root) { $root.Dispose() } }
`;

export const readWindowsProcessTree = (root: WindowsProcessIdentity) =>
  runPowerShell(
    windowsProcessTreeCommand({
      rootPid: root.pid,
      creationTime: root.creationTime,
      // Without a live root handle, reject direct children created during the
      // PowerShell startup/query window: that PID may have been recycled.
      exitedBefore:
        Temporal.Now.instant().epochNanoseconds / NANOS_PER_FILETIME_TICK +
        WINDOWS_FILETIME_UNIX_EPOCH,
    }),
  )
    .andThen((output) =>
      output === ""
        ? Result.ok({ rows: [], unavailable: undefined })
        : parseWindowsProcessRows(output),
    )
    .andThen(({ rows, unavailable }) => {
      const identities: WindowsProcessIdentity[] = [];
      for (const { pid, creationTime } of rows) {
        if (creationTime !== undefined) {
          identities.push({ pid, creationTime });
        }
      }
      return Result.ok({ identities, unavailable });
    });

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
  readTree?: typeof readWindowsProcessTree;
};

export const createWindowsProcessOwnership = ({
  rootPid,
  onWarning,
  readIdentity = readWindowsProcessIdentity,
  signalProcesses = signalWindowsProcesses,
  readTree = readWindowsProcessTree,
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
  const recordTree = (sample: readonly WindowsProcessIdentity[]) => {
    const root = identities.get(rootPid);
    const sampledRoot = sample.find(({ pid }) => pid === rootPid);
    if (root === undefined || sampledRoot?.creationTime !== root.creationTime) {
      return;
    }
    for (const identity of sample) {
      identities.set(identity.pid, identity);
    }
  };
  let terminalCensus: "pending" | "captured" = "pending";
  const finish = () => {
    if (terminalCensus === "captured") {
      return;
    }
    const root = identities.get(rootPid);
    if (root === undefined) {
      return;
    }
    const read = readTree(root);
    if (read.isErr()) {
      onWarning(
        `Cannot retain final descendants of PID ${rootPid}: ${read.error.message}`,
      );
      return;
    }
    recordTree(read.value.identities);
    if (read.value.unavailable !== undefined) {
      onWarning(
        `Final descendants of PID ${rootPid} partially unavailable: ${read.value.unavailable.message}`,
      );
      return;
    }
    terminalCensus = "captured";
  };
  return {
    capturePid,
    recordTree,
    finish,
    signal: (signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        finish();
      }
      return signalProcesses({
        rootPid,
        identities: [...identities.values()],
        signal,
      });
    },
  };
};
