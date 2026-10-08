import { panic } from "better-result";

import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "../screening";
import {
  MONITORING_CONTACT_COUNT,
  MONITORING_SCREENING_PASSES,
  MATCHER_REPORT_BATCH_SIZE,
  MONITORING_ENTRY_COUNT,
  syntheticMonitoringEntry,
  syntheticMonitoringName,
} from "./monitoring-corpus";
import { processPeakMemoryBytes } from "./process-peak-memory";

const runMatcherMemoryWorkload = async () => {
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-09-30", fileId: null },
      entries: Array.from({ length: MONITORING_ENTRY_COUNT }, (_, entry) =>
        syntheticMonitoringEntry(entry),
      ),
    },
  ]);
  await Bun.write(Bun.stdout, `${processPeakMemoryBytes()}\n`);
  let hits = 0;
  for (let pass = 0; pass < MONITORING_SCREENING_PASSES; pass += 1) {
    for (let contact = 0; contact < MONITORING_CONTACT_COUNT; contact += 1) {
      const result = screen(
        index,
        { name: syntheticMonitoringName(contact), entityType: "person" },
        { cutoff: DEFAULT_CUTOFF, limit: MONITORING_ENTRY_COUNT },
      );
      if (result.isErr()) {
        panic("Matcher memory workload rejected its corpus subject");
      }
      hits += result.value.totalMatches;
      if ((contact + 1) % MATCHER_REPORT_BATCH_SIZE === 0) {
        // Report the OS high-water mark so the parent can stop a growing regression before OOM.
        await Bun.write(Bun.stdout, `${processPeakMemoryBytes()}\n`);
      }
    }
  }
  if (hits !== MONITORING_CONTACT_COUNT * MONITORING_SCREENING_PASSES) {
    panic("Matcher memory workload lost corpus matches");
  }
};

if (import.meta.main) {
  await runMatcherMemoryWorkload();
}
