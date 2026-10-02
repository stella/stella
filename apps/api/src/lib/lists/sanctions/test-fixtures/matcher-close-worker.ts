import { panic } from "better-result";
import { MessagePort, parentPort, workerData } from "node:worker_threads";

const acknowledgement = workerData.acknowledgement;
if (!(acknowledgement instanceof MessagePort) || parentPort === null) {
  panic("Shutdown fixture requires an acknowledgement port");
}
parentPort.on("message", () => {
  acknowledgement.postMessage("exchange-started", []);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
});
