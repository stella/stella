import { panic } from "better-result";

import { buildScreeningIndex } from "../screening";
import { compactLists } from "./compact-lists";
import { buildScreeningIndex as buildLegacyScreeningIndex } from "./legacy-screening";

const mode = Bun.argv.at(2);
Bun.gc(true);
const before = process.memoryUsage().heapUsed;
const build = () => {
  switch (mode) {
    case "legacy":
      return buildLegacyScreeningIndex(compactLists());
    case "compact":
      return buildScreeningIndex(compactLists());
    default:
      return panic("Unknown memory probe mode");
  }
};
const index = build();
// Leave the construction stack before collecting: JSC conservatively scans
// stack slots that may still reference discarded builder buffers.
await Bun.sleep(0);
Bun.gc(true);
const heap = process.memoryUsage().heapUsed - before;
process.stdout.write(JSON.stringify({ heap, entries: index.entries.length }));
// Keep the entire index live across GC; accessing length alone can let engines
// discard other fields before the measurement.
if (index.names.aliases.length === 0) {
  panic("Memory probe built an empty index");
}
