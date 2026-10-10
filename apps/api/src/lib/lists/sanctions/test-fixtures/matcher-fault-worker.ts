import { panic } from "better-result";
import { MessagePort, parentPort, workerData } from "node:worker_threads";

const data: unknown = workerData;
if (
  typeof data !== "object" ||
  data === null ||
  !("fault" in data) ||
  !("acknowledgement" in data) ||
  !(data.acknowledgement instanceof MessagePort) ||
  parentPort === null
) {
  panic("Invalid matcher fault fixture");
}
const { fault, acknowledgement } = data;
if (fault !== "hang" && fault !== "crash") {
  panic("Unknown matcher fault");
}

parentPort.on("message", () => {
  acknowledgement.postMessage("entered", []);
  if (fault === "crash") {
    process.exit(1);
  }
  // The parent must interrupt a stalled worker; no wall-clock recovery races its deadline.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});
