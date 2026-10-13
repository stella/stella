import { panic, Result } from "better-result";
import { Worker } from "node:worker_threads";

import { createTypstWasmCompiler } from "./compiler";
import type { TypstWorkerReply, TypstWorkerRequest } from "./protocol";

// Renderer process: compiles on its main thread, while a watchdog thread
// bounds its memory. The session kills the whole process on timeout, which is
// the only reliable way to stop a synchronous WASM compile.
const send = (reply: TypstWorkerReply) => {
  if (process.send === undefined) {
    return panic("The Typst renderer must run with an IPC channel");
  }
  return process.send(reply);
};

const maxGrowthBytes = Number(process.argv[2]);
if (!Number.isSafeInteger(maxGrowthBytes) || maxGrowthBytes <= 0) {
  panic("The Typst renderer needs a positive memory growth limit");
}

const compiler = await createTypstWasmCompiler();
/** Starts the memory watchdog thread; returns the peak RSS it records. */
const startWatchdog = () => {
  const peak = new Float64Array(new SharedArrayBuffer(8));
  peak[0] = process.memoryUsage.rss();
  const watchdog = new Worker(new URL("watchdog.ts", import.meta.url), {
    workerData: { capBytes: process.memoryUsage.rss() + maxGrowthBytes, peak },
  });
  watchdog.unref();
  return peak;
};
const peak = startWatchdog();

const replyTo = (request: TypstWorkerRequest): TypstWorkerReply => {
  const started = performance.now();
  const usage = () => ({
    memoryBytes: compiler.memoryBytes(),
    peakRssBytes: peak[0] ?? 0,
  });
  // A Rust panic surfaces as a thrown RuntimeError and leaves the module in
  // an undefined state; the session retires this process on "crashed".
  const compiled = Result.try(() => compiler.compile(request));
  if (compiled.isErr()) {
    return {
      type: "failed",
      id: request.id,
      reason: "crashed",
      diagnostics: [String(compiled.error.cause)],
      ...usage(),
    };
  }
  const outcome = compiled.value;
  if (outcome.status === "error") {
    return {
      type: "failed",
      id: request.id,
      reason: "diagnostics",
      diagnostics: outcome.diagnostics,
      ...usage(),
    };
  }
  if (outcome.bytes.byteLength > request.maxOutputBytes) {
    return {
      type: "failed",
      id: request.id,
      reason: "output-too-large",
      diagnostics: [
        `Output is ${String(outcome.bytes.byteLength)} bytes; the limit is ${String(request.maxOutputBytes)}`,
      ],
      ...usage(),
    };
  }
  return {
    type: "rendered",
    id: request.id,
    bytes: outcome.bytes,
    compileMs: performance.now() - started,
    ...usage(),
  };
};

process.on("message", (request: TypstWorkerRequest) => {
  send(replyTo(request));
});

send({ type: "ready" });
