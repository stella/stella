import { panic } from "better-result";

import { buildScreeningIndex, DEFAULT_CUTOFF, screen } from "../screening";
import {
  MONITORING_CONTACT_COUNT,
  MONITORING_ENTRY_COUNT,
  syntheticMonitoringEntry,
  syntheticMonitoringName,
} from "./monitoring-corpus";

// Both database benchmark phases screen this same volume through one compiled edition.
const SCREENING_PASSES = 2;
const REPORT_BATCH_SIZE = 100;
export const MATCHER_WORKLOAD_REPORT_COUNT =
  1 + (MONITORING_CONTACT_COUNT * SCREENING_PASSES) / REPORT_BATCH_SIZE;

const runMatcherMemoryWorkload = async () => {
  const index = buildScreeningIndex([
    {
      version: { source: "eu", publishedAt: "2026-09-30", fileId: null },
      entries: Array.from({ length: MONITORING_ENTRY_COUNT }, (_, entry) =>
        syntheticMonitoringEntry(entry),
      ),
    },
  ]);
  await Bun.write(Bun.stdout, `${process.resourceUsage().maxRSS}\n`);
  let hits = 0;
  for (let pass = 0; pass < SCREENING_PASSES; pass += 1) {
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
      if ((contact + 1) % REPORT_BATCH_SIZE === 0) {
        // Report the OS high-water mark so the parent can stop a growing regression before OOM.
        await Bun.write(Bun.stdout, `${process.resourceUsage().maxRSS}\n`);
      }
    }
  }
  if (hits !== MONITORING_CONTACT_COUNT * SCREENING_PASSES) {
    panic("Matcher memory workload lost corpus matches");
  }
};

if (import.meta.main) {
  await runMatcherMemoryWorkload();
}
