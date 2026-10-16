import { panic } from "better-result";

import { buildScreeningIndex } from "../screening";
import { compactLists } from "./compact-lists";
import { buildScreeningIndex as buildLegacyScreeningIndex } from "./legacy-screening";

const mode = Bun.argv.at(2);
Bun.gc(true);
const before = process.memoryUsage().heapUsed;
const build = () => {
  switch (mode) {
    case "legacy": {
      const built = buildLegacyScreeningIndex(compactLists());
      return { index: built, nativeBytes: 0 };
    }
    case "compact": {
      const built = buildScreeningIndex(compactLists());
      // The entity index lives outside the JavaScript heap; count it too.
      return { index: built, nativeBytes: built.names.candidates.nativeBytes };
    }
    case undefined:
      return panic("Missing memory probe mode");
    default:
      return panic("Unknown memory probe mode");
  }
};
const { index, nativeBytes } = build();
// Leave the construction stack before collecting: JSC conservatively scans
// stack slots that may still reference discarded builder buffers.
await Bun.sleep(0);
Bun.gc(true);
const heap = process.memoryUsage().heapUsed - before + nativeBytes;
process.stdout.write(JSON.stringify({ heap, entries: index.entries.length }));
// Keep the entire index live across GC; accessing length alone can let engines
// discard other fields before the measurement.
if (index.names.aliases.length === 0) {
  panic("Memory probe built an empty index");
}
