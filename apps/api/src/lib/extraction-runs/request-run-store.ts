import { rootDb } from "@/api/db/root";
import { createExtractionRunStore } from "@/api/lib/extraction-runs/store";
import type { ExtractionRunStartStore } from "@/api/lib/extraction-runs/store";

const ownerRunStore = createExtractionRunStore(rootDb);

/**
 * The run lifecycle a request writes when it starts a workflow.
 *
 * `extraction_runs` admits no tenant writes, so a request records the run it
 * starts on the owner connection. It gets only the transitions a starter
 * performs before any worker holds the run; the workers record progress and
 * completion on the store their host builds, and pass that same store to the
 * runs they start themselves.
 */
export const requestExtractionRunStore = {
  create: ownerRunStore.create,
  fail: ownerRunStore.fail,
  skip: ownerRunStore.skip,
  start: ownerRunStore.start,
} satisfies ExtractionRunStartStore;
