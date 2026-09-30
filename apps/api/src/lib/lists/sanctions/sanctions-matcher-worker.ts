import { panic } from "better-result";
import { parentPort } from "node:worker_threads";

import { buildScreeningIndex, screen } from "@stll/sanctions";
import type { SanctionsSource, ScreeningIndex } from "@stll/sanctions";

import type {
  SanctionsMatcherReply,
  SanctionsMatcherRequest,
} from "./matcher-protocol";

const port = parentPort;
if (port === null) {
  panic("The sanctions matcher must run in a worker thread");
}
const indexes = new Map<
  SanctionsSource,
  { editionId: string; index: ScreeningIndex }
>();
port.on("message", (request: SanctionsMatcherRequest) => {
  let cached = indexes.get(request.source);
  if (cached?.editionId !== request.editionId) {
    // Drop the previous edition before allocating its replacement.
    indexes.delete(request.source);
    if (request.list === null) {
      port.postMessage({
        status: "unavailable",
      } satisfies SanctionsMatcherReply);
      return;
    }
    cached = {
      editionId: request.editionId,
      index: buildScreeningIndex([request.list]),
    };
    indexes.set(request.source, cached);
  }
  const result = screen(cached.index, request.query, {
    cutoff: request.cutoff,
    limit: request.limit,
  });
  port.postMessage(
    result.isOk()
      ? ({
          status: "screened",
          result: result.value,
        } satisfies SanctionsMatcherReply)
      : ({ status: "unavailable" } satisfies SanctionsMatcherReply),
  );
});
