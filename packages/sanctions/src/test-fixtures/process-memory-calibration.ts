import { processPeakMemoryBytes } from "./process-peak-memory";

const ALLOCATION_BYTES = 128 * 1024 * 1024;
const baselineBytes = processPeakMemoryBytes();
const allocation = new Uint8Array(ALLOCATION_BYTES);
allocation.fill(1);
const peakBytes = processPeakMemoryBytes();
let touchedPages = 0;
for (let offset = 0; offset < allocation.length; offset += 4096) {
  touchedPages += allocation[offset] ?? 0;
}
await Bun.write(
  Bun.stdout,
  JSON.stringify({
    baselineBytes,
    peakBytes,
    allocationBytes: ALLOCATION_BYTES,
    touchedPages,
    nodePeakKiB: process.resourceUsage().maxRSS,
  }),
);
