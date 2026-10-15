import { panic } from "better-result";
import { spyOn } from "bun:test";
import { Worker } from "node:worker_threads";

import type { SanctionsMatcherMessage } from "../matcher-protocol";

// Count real transfers and evaluations while preserving the worker boundary.
export const recordingMatcherWorker = () => {
  const work = {
    entryBatches: 0,
    entries: 0,
    maximumBatchEntries: 0,
    screenings: 0,
    indexes: 0,
  };
  const createWorker = () => {
    const worker = new Worker(
      new URL("../sanctions-matcher-worker.ts", import.meta.url),
    );
    const postMessage = worker.postMessage.bind(worker);
    spyOn(worker, "postMessage").mockImplementation(
      (message: SanctionsMatcherMessage, transferList) => {
        switch (message.type) {
          case "entries":
            work.entryBatches += 1;
            work.entries += message.entries.length;
            work.maximumBatchEntries = Math.max(
              work.maximumBatchEntries,
              message.entries.length,
            );
            break;
          case "index":
            work.indexes += 1;
            break;
          case "screen":
            work.screenings += 1;
            break;
          default: {
            message satisfies never;
            panic("Unexpected matcher message");
          }
        }
        postMessage(message, transferList);
      },
    );
    return worker;
  };
  return { work, createWorker };
};
