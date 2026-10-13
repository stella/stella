import { panic } from "better-result";

import { attachTestProcessShutdown } from "../process-shutdown";

const child = Bun.spawn(
  [
    process.execPath,
    `${import.meta.dir}/signal-cleanup-child.ts`,
    process.argv.at(2) ?? panic("Missing marker"),
    "leader-exit",
  ],
  {
    detached: process.platform !== "win32",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  },
);
const shutdown = attachTestProcessShutdown({
  child,
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
// The spawning fixture communicates the known worker before exiting its leader.
shutdown.windowsProcesses?.capturePid(workerPid);
await child.stdin.end();
await child.exited;
console.log(`${child.pid} ${workerPid}`);
await Bun.stdin.text();
shutdown.dispose();
process.exit(0);
