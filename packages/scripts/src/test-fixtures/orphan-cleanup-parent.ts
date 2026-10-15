import { panic } from "better-result";

import {
  createProcessMemoryReader,
  watchTestProcessMemory,
} from "../process-memory";
import { attachTestProcessShutdown } from "../process-shutdown";
import { spawnTestProcess } from "../process-spawn";

const readBytes = await createProcessMemoryReader();

const { child, windowsProcesses } = spawnTestProcess({
  limitBytes: 1024 ** 3,
  command: [
    process.execPath,
    `${import.meta.dir}/signal-cleanup-child.ts`,
    process.argv.at(2) ?? panic("Missing marker"),
    "leader-exit",
  ],
  options: {
    detached: process.platform !== "win32",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  },
  onWarning: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
const shutdown = attachTestProcessShutdown({
  child,
  windowsProcesses,
  termination: process.platform === "win32" ? "process" : "group",
  onWarning: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
const ready = await child.stdout.getReader().read();
const workerPid = Number(new TextDecoder().decode(ready.value).trim());
if (!Number.isSafeInteger(workerPid) || workerPid <= 1) {
  panic("Missing worker PID");
}
const watchdog = watchTestProcessMemory({
  child,
  readBytes,
  windowsProcesses: shutdown.windowsProcesses,
  limitBytes: 1024 ** 3,
  intervalMs: 60_000,
  file: () => "orphan fixture",
  onFailure: (message) => {
    panic(message);
  },
  onWarning: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
await child.exited;
console.log(`${child.pid} ${workerPid}`);
await Bun.stdin.text();
await watchdog.stop();
shutdown.dispose();
process.exit(0);
