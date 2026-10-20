import { panic } from "better-result";
import { existsSync } from "node:fs";

// This preload runs before the leader's entry point (including `bun test`).
// Workers cannot exist until the owner has retained the leader's exact birth.
const gate = process.env["STELLA_TEST_PROCESS_STARTUP_GATE"];
delete process.env["STELLA_TEST_PROCESS_STARTUP_GATE"];
if (gate === undefined) {
  panic("Missing test process startup gate");
}
const deadline = performance.now() + 15_000;
const waiting = new Int32Array(new SharedArrayBuffer(4));
while (existsSync(gate)) {
  if (performance.now() >= deadline) {
    panic("Test process ownership registration timed out");
  }
  Atomics.wait(waiting, 0, 0, 10);
}
