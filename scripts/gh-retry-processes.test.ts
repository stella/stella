import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HELPER = path.resolve(import.meta.dir, "gh-retry.sh");
// Delayed TERM completion exposes a parent that kills without waiting; the
// process snapshot must not accidentally give that child time to finish.
const FAKE_GH = `#!/usr/bin/env python3
import json,os,pathlib,signal,subprocess,sys,time
def terminate(signum,frame):
 time.sleep(0.5)
 sys.exit(143)
signal.signal(signal.SIGTERM,terminate)
root=pathlib.Path(os.environ['FAKE_ROOT'])
(root/'command.tmp').write_text(json.dumps({'pid':os.getpid(),'parent':os.getppid()}))
os.replace(root/'command.tmp',root/'command.json')
deadline=time.monotonic()+3
mode=os.environ['FAKE_LIFECYCLE']
if mode not in ('command-startup','pretrap'):
 while not (root/'timer.json').exists():
  if time.monotonic()>deadline:sys.exit(90)
  time.sleep(0.005)
if mode in ('startup','pretrap'):
 while not (root/'startup-ready').exists():
  if time.monotonic()>deadline:sys.exit(91)
  time.sleep(0.005)
if mode=='pretrap':
 rows=subprocess.check_output(['ps','-axo','pid=,ppid='],text=True).splitlines()
 watchers=[int(row.split()[0]) for row in rows if int(row.split()[1])==os.getppid() and int(row.split()[0])!=os.getpid()]
 if len(watchers)!=1:sys.exit(94)
 (root/'watchdog.tmp').write_text(json.dumps({'pid':watchers[0],'parent':os.getppid()}))
 os.replace(root/'watchdog.tmp',root/'watchdog.json')
if mode in ('deadline','term','command-startup','watchdog-startup'):
 (root/'hanging').touch()
 while True:time.sleep(1)
if mode=='failure':
 sys.stderr.write('< HTTP/2.0 400\\n')
 sys.exit(1)
print('complete')
`;
const FAKE_SLEEP = `#!/usr/bin/env python3
import json,os,pathlib,signal,sys,time
if os.environ['FAKE_LIFECYCLE']=='ignored-timer':signal.signal(signal.SIGTERM,signal.SIG_IGN)
root=pathlib.Path(os.environ['FAKE_ROOT'])
(root/'timer.tmp').write_text(json.dumps({'pid':os.getpid(),'parent':os.getppid()}))
os.replace(root/'timer.tmp',root/'timer.json')
if os.environ['FAKE_LIFECYCLE']=='pretrap':
 os.execv('/bin/sleep',['sleep','0.3'])
if os.environ['FAKE_LIFECYCLE']=='deadline':
 deadline=time.monotonic()+3
 while not (root/'hanging').exists():
  if time.monotonic()>deadline:sys.exit(92)
  time.sleep(0.005)
 os.execv('/bin/sleep',['sleep','0.05'])
os.execv('/bin/sleep',['sleep',sys.argv[1]])
`;

// Interrupt each process acquisition before its PID assignment. Ownership must
// already exist in the shell's job table while its saved PID is still empty.
// A provisional TERM handler also consumes the signal before watchdog setup,
// so durable stop intent must survive signal loss and dispose any started timer.
// The final barrier delivers TERM while EXIT cleanup has begun, before it can
// mask signals, and permits nested cleanup to finish ownership disposal.
const WATCHDOG_STARTUP = `set -T
hold_exit_cleanup() {
  : > "$FAKE_ROOT/cleanup-ready"
  stop_at=$((SECONDS + 3))
  while ((SECONDS < stop_at)); do :; done
}
stop_before_pid_assignment() {
  if [[ "$FAKE_LIFECYCLE" == exit-startup ]]; then
    if ((BASH_SUBSHELL > 0)) &&
      [[ "$BASH_COMMAND" == "trap 'stop_owned_jobs; exit 0' TERM INT" || "$BASH_COMMAND" == "trap 'exit 0' TERM INT" ]]; then
      # GNU Bash does not trace DEBUG inside EXIT callbacks; add the barrier
      # before invoking the real cleanup, preserving its body and TERM handler.
      trap 'hold_exit_cleanup; stop_owned_jobs' EXIT
    fi
    if ((BASH_SUBSHELL == 0)) && [[ "$BASH_COMMAND" == 'kill "$watchdog"'* ]]; then
      stop_at=$((SECONDS + 3))
      while [[ ! -e "$FAKE_ROOT/cleanup-ready" ]] && ((SECONDS < stop_at)); do :; done
    elif ((BASH_SUBSHELL > 0)) && [[ "$BASH_COMMAND" == '[[ ! -e "$scratch/stop-watchdog" ]]' ]]; then
      stop_at=$((SECONDS + 3))
      while [[ ! -e "$scratch/stop-watchdog" ]] && ((SECONDS < stop_at)); do :; done
    fi
    return 0
  fi
  if [[ "$FAKE_LIFECYCLE" == pretrap ]] && ((BASH_SUBSHELL > 0)) &&
    [[ "$BASH_COMMAND" == 'trap stop_owned_jobs EXIT' || "$BASH_COMMAND" == 'sleep "$remaining"' ]]; then
    trap ': > "$FAKE_ROOT/early-term"' TERM
    : > "$FAKE_ROOT/startup-ready"
    stop_at=$((SECONDS + 3))
    while [[ ! -e "$FAKE_ROOT/early-term" ]] && ((SECONDS < stop_at)); do :; done
    return 0
  fi
  case "$FAKE_LIFECYCLE:$BASH_COMMAND" in
    'startup:timer=$!') ((BASH_SUBSHELL > 0)) || return 0 ;;
    'command-startup:command_pid=$!') ((BASH_SUBSHELL == 0)) || return 0 ;;
    'watchdog-startup:watchdog=$!') ((BASH_SUBSHELL == 0)) || return 0 ;;
    *) return 0 ;;
  esac
  : > "$FAKE_ROOT/startup-ready"
  stop_at=$((SECONDS + 3))
  while ((SECONDS < stop_at)); do :; done
  exit 93
}
trap stop_before_pid_assignment DEBUG
`;

type ProcessRecord = { pid: number; parent: number };
const isProcessRecord = (value: unknown): value is ProcessRecord =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  "parent" in value &&
  typeof value.parent === "number";

const processRecord = async (filename: string) => {
  const value: unknown = JSON.parse(await readFile(filename, "utf-8"));
  expect(isProcessRecord(value)).toBe(true);
  if (!isProcessRecord(value)) {
    throw new TypeError("Fixture did not record a process identity");
  }
  return value;
};

const waitForFile = async (filename: string) => {
  const expires = Date.now() + 3000;
  while (!(await Bun.file(filename).exists())) {
    if (Date.now() >= expires) {
      throw new TypeError(
        "Fixture process did not reach its readiness barrier",
      );
    }
    await Bun.sleep(5);
  }
};

const activePids = () => {
  // Include zombies: kill(0) or ancestor walks alone can hide reparented children.
  const snapshot = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,stat=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(snapshot.exitCode).toBe(0);
  return snapshot.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => Number(line.trim().split(/\s+/u).at(0)));
};

// Processes the helper owns in each scenario: startup interruptions stop
// before the watchdog (command-startup) or its timer (pretrap) exists.
const ownedProcessCount = (name: string): number => {
  if (name === "command-startup") {
    return 2;
  }
  if (name === "pretrap") {
    return 3;
  }
  return 4;
};

const scenarios = [
  { name: "success", exit: 0 },
  { name: "failure", exit: 1 },
  { name: "deadline", exit: 124 },
  { name: "term", exit: 143 },
  { name: "startup", exit: 0 },
  { name: "command-startup", exit: 143 },
  { name: "watchdog-startup", exit: 143 },
  { name: "pretrap", exit: 0 },
  { name: "exit-startup", exit: 0 },
  { name: "ignored-timer", exit: 0 },
];

for (const scenario of scenarios) {
  test(`reaps the command watchdog and timer after ${scenario.name}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "gh-retry-processes-"));
    await writeFile(path.join(directory, "gh"), FAKE_GH);
    await writeFile(path.join(directory, "sleep"), FAKE_SLEEP);
    await chmod(path.join(directory, "gh"), 0o700);
    await chmod(path.join(directory, "sleep"), 0o700);
    const startup = path.join(directory, "startup.sh");
    await writeFile(startup, WATCHDOG_STARTUP);
    const child = Bun.spawn(["bash", HELPER, "api", "repos/example/project"], {
      env: {
        ...Bun.env,
        PATH: `${directory}:${Bun.env["PATH"] ?? ""}`,
        FAKE_ROOT: directory,
        FAKE_LIFECYCLE: scenario.name,
        ...(scenario.name.endsWith("startup") || scenario.name === "pretrap"
          ? { BASH_ENV: startup }
          : {}),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const supervisor = setTimeout(() => child.kill("SIGKILL"), 4000);
    let ownedPids: number[] = [child.pid];
    try {
      await waitForFile(path.join(directory, "command.json"));
      const command = await processRecord(path.join(directory, "command.json"));
      ownedPids = [child.pid, command.pid];
      expect(command.parent).toBe(child.pid);
      if (scenario.name !== "command-startup" && scenario.name !== "pretrap") {
        await waitForFile(path.join(directory, "timer.json"));
        const timer = await processRecord(path.join(directory, "timer.json"));
        ownedPids.push(timer.parent, timer.pid);
      }
      if (scenario.name === "pretrap") {
        await waitForFile(path.join(directory, "watchdog.json"));
        const watchdog = await processRecord(
          path.join(directory, "watchdog.json"),
        );
        expect(watchdog.parent).toBe(child.pid);
        ownedPids.push(watchdog.pid);
      }
      expect(new Set(ownedPids).size).toBe(ownedProcessCount(scenario.name));
      if (
        scenario.name === "term" ||
        scenario.name === "command-startup" ||
        scenario.name === "watchdog-startup"
      ) {
        await waitForFile(path.join(directory, "hanging"));
        if (scenario.name !== "term") {
          await waitForFile(path.join(directory, "startup-ready"));
        }
        child.kill("SIGTERM");
      }
      const exit = await child.exited;
      if (
        scenario.name === "pretrap" &&
        (await Bun.file(path.join(directory, "timer.json")).exists())
      ) {
        const timer = await processRecord(path.join(directory, "timer.json"));
        ownedPids.push(timer.pid);
      }
      const live = activePids();
      expect(ownedPids.filter((pid) => live.includes(pid))).toEqual([]);
      expect(exit).toBe(scenario.exit);
      if (
        (scenario.name.endsWith("startup") &&
          scenario.name !== "exit-startup") ||
        scenario.name === "pretrap"
      ) {
        expect(
          await Bun.file(path.join(directory, "startup-ready")).exists(),
        ).toBe(true);
      }
      if (scenario.name === "pretrap") {
        expect(
          await Bun.file(path.join(directory, "early-term")).exists(),
        ).toBe(true);
      }
      if (scenario.name === "exit-startup") {
        expect(
          await Bun.file(path.join(directory, "cleanup-ready")).exists(),
        ).toBe(true);
      }
      await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
    } finally {
      clearTimeout(supervisor);
      // Failed assertions must remain visible before disposing fixture leftovers.
      for (const pid of ownedPids) {
        Bun.spawnSync(["kill", "-KILL", String(pid)], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
