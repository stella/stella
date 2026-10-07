import { panic } from "better-result";
import { parentPort } from "node:worker_threads";

import { buildScreeningIndex, screen } from "@stll/sanctions";
import type {
  SanctionsEntry,
  SanctionsSource,
  ScreeningIndex,
} from "@stll/sanctions";

import type {
  SanctionsMatcherReply,
  SanctionsMatcherMessage,
} from "./matcher-protocol";

const port = parentPort;
if (port === null) {
  panic("The sanctions matcher must run in a worker thread");
}
const indexes = new Map<
  SanctionsSource,
  { editionId: string; index: ScreeningIndex }
>();
let assembly: {
  source: SanctionsSource;
  editionId: string;
  entries: SanctionsEntry[];
} | null = null;
port.on("message", (request: SanctionsMatcherMessage) => {
  if (request.type === "entries") {
    if (request.offset === 0) {
      indexes.delete(request.source);
      assembly = {
        source: request.source,
        editionId: request.editionId,
        entries: [],
      };
    }
    if (
      assembly === null ||
      assembly.source !== request.source ||
      assembly.editionId !== request.editionId ||
      assembly.entries.length !== request.offset
    ) {
      panic("Invalid sanctions entry transfer sequence");
    }
    assembly.entries.push(...request.entries);
    port.postMessage({
      status: "entries-loaded",
    } satisfies SanctionsMatcherReply);
    return;
  }
  let cached = indexes.get(request.source);
  if (cached?.editionId !== request.editionId) {
    // Drop the previous edition before allocating its replacement.
    indexes.delete(request.source);
    if (request.version === null) {
      port.postMessage({
        status: "unavailable",
      } satisfies SanctionsMatcherReply);
      return;
    }
    const entries = assembly === null ? [] : assembly.entries;
    if (
      assembly !== null &&
      (assembly.source !== request.source ||
        assembly.editionId !== request.editionId)
    ) {
      panic("Invalid sanctions entry transfer owner");
    }
    cached = {
      editionId: request.editionId,
      index: buildScreeningIndex([{ version: request.version, entries }]),
    };
    indexes.set(request.source, cached);
  }
  assembly = null;
  const result = screen(cached.index, request.query, {
    cutoff: request.cutoff,
    limit: request.limit,
  });
  if (result.isErr()) {
    if (result.error.code !== "work-limit") {
      panic("A validated sanctions worker query was rejected");
    }
    port.postMessage({ status: "work-limit" } satisfies SanctionsMatcherReply);
    return;
  }
  port.postMessage({
    status: "screened",
    result: result.value,
  } satisfies SanctionsMatcherReply);
});
