import { attachTestProcessShutdown } from "../test-process-shutdown";

const child = Bun.spawn(
  [
    process.execPath,
    `${import.meta.dir}/signal-cleanup-child.ts`,
    ...process.argv.slice(2),
  ],
  {
    detached: true,
    stdout: "pipe",
    stderr: "inherit",
  },
);
const shutdown = attachTestProcessShutdown({
  child,
  termination: "group",
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
await child.exited;
shutdown.dispose();
process.exit(shutdown.exitCode() ?? 0);
