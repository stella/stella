import { attachTestProcessShutdown } from "../process-shutdown";

const child = Bun.spawn(
  [
    process.execPath,
    `${import.meta.dir}/signal-cleanup-child.ts`,
    ...process.argv.slice(2),
  ],
  {
    detached: process.platform !== "win32",
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
const reader = child.stdout.getReader();
const ready = await reader.read();
console.log(`${child.pid} ${new TextDecoder().decode(ready.value).trim()}`);
if (process.argv.at(3) === "exit") {
  process.exit(23);
}
if (process.platform === "win32") {
  // Windows kill() terminates the runner without invoking JS signal handlers.
  // Use stdin to exercise the same handler a console shutdown invokes.
  const signal = (await Bun.stdin.text()).trim();
  if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") {
    process.emit(signal);
  }
}
await child.exited;
shutdown.dispose();
process.exit(shutdown.exitCode() ?? 0);
