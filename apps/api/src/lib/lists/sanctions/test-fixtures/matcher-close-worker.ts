import { panic } from "better-result";
import { MessagePort, parentPort, workerData } from "node:worker_threads";

const data: unknown = workerData;
if (typeof data !== "object" || data === null || !("acknowledgement" in data)) {
  panic("Shutdown fixture requires worker data with an acknowledgement port");
}
const acknowledgement = data.acknowledgement;
if (!(acknowledgement instanceof MessagePort) || parentPort === null) {
  panic("Shutdown fixture requires an acknowledgement port");
}
parentPort.on("message", () => {
  acknowledgement.postMessage("exchange-started", []);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
