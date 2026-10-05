import { parentPort, workerData } from "node:worker_threads";

parentPort?.on("message", () => {
  if (workerData === "crash") {
    process.exit(1);
  }
  // Deliberate synchronous stall: a main-thread deadline must interrupt it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  parentPort?.postMessage({ status: "unavailable" }, []);
});
