import { panic, Result } from "better-result";
import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";

import {
  initRecordingReader,
  openRecording,
  recordingWasmUrl,
} from "@stll/recording-wasm";
import type { OpenedRecording } from "@stll/recording-wasm";

import type {
  RecordingReaderMessage,
  RecordingReaderReply,
} from "./recording-reader-protocol";

const port = parentPort;
if (port === null) {
  panic("The recording reader must run in a worker thread");
}
initRecordingReader(new WebAssembly.Module(readFileSync(recordingWasmUrl())));

const reply = (message: RecordingReaderReply, transfer: ArrayBuffer[] = []) =>
  port.postMessage(message, transfer);

let opened: OpenedRecording | null = null;
port.on("message", (request: RecordingReaderMessage) => {
  if (request.type === "open") {
    const bytes = new Uint8Array(request.bytes);
    const result = openRecording({
      size: bytes.byteLength,
      chunks: [bytes],
      extension: request.extension,
    });
    if (Result.isError(result)) {
      reply({ type: "refused", refusal: result.error.refusal });
      return;
    }
    opened = result.value;
    reply({ type: "opened", durationMs: opened.durationMs });
    return;
  }
  if (opened === null) {
    panic("The recording reader was asked for a piece before opening");
  }
  const next = opened.next();
  if (Result.isError(next)) {
    opened.close();
    opened = null;
    reply({ type: "refused", refusal: next.error.refusal });
    return;
  }
  if (next.value === null) {
    opened.close();
    opened = null;
    reply({ type: "end" });
    return;
  }
  const { wav } = next.value;
  reply(
    { type: "piece", piece: next.value },
    wav.buffer instanceof ArrayBuffer ? [wav.buffer] : [],
  );
});
