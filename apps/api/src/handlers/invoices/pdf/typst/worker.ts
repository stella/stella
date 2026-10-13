import { panic } from "better-result";
import { parentPort } from "node:worker_threads";

import { createTypstWasmCompiler } from "./compiler";
import type { TypstWorkerReply, TypstWorkerRequest } from "./protocol";

const port = parentPort ?? panic("The Typst renderer must run in a worker");
const compiler = await createTypstWasmCompiler();

port.on("message", (request: TypstWorkerRequest) => {
  const started = performance.now();
  let reply: TypstWorkerReply;
  try {
    const outcome = compiler.compile(request);
    if (outcome.status === "error") {
      reply = {
        type: "failed",
        id: request.id,
        reason: "diagnostics",
        diagnostics: outcome.diagnostics,
        memoryBytes: compiler.memoryBytes(),
      };
    } else if (outcome.bytes.byteLength > request.maxOutputBytes) {
      reply = {
        type: "failed",
        id: request.id,
        reason: "output-too-large",
        diagnostics: [
          `Output is ${String(outcome.bytes.byteLength)} bytes; the limit is ${String(request.maxOutputBytes)}`,
        ],
        memoryBytes: compiler.memoryBytes(),
      };
    } else {
      reply = {
        type: "rendered",
        id: request.id,
        bytes: outcome.bytes,
        compileMs: performance.now() - started,
        memoryBytes: compiler.memoryBytes(),
      };
    }
  } catch (error) {
    // A Rust panic surfaces as a thrown RuntimeError and leaves the module
    // in an undefined state; the session retires this worker.
    reply = {
      type: "failed",
      id: request.id,
      reason: "crashed",
      diagnostics: [String(error)],
      memoryBytes: compiler.memoryBytes(),
    };
  }
  port.postMessage(reply);
});

port.postMessage({ type: "ready" } satisfies TypstWorkerReply);
